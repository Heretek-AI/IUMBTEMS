// Audit #197 integration tests (opencode side): TypeScript diagnostics end to
// end on the real host, the /lsp server command, and the after-edit
// diagnostics channel for an lsp:"none" seat. Testkit host + the existing tsc
// fixture seam only; no sandboxed binaries are run directly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { agentSpec, LspManager } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { EsRpc } from "../src/rpc-def.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const TYPESCRIPT = path.resolve(import.meta.dir, "../../../node_modules/typescript")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

let state: string
let h: Harness
let closed = false
// Plugin unload is the only shutdown path: server.ts returns stopAll on
// unload, and between sessions only the idle sweeper reaps. Spying the manager
// proves host close shuts the servers down.
const originalStopAll = LspManager.prototype.stopAll
let stopCalls = 0

const closeOnce = async () => {
  if (!closed) {
    closed = true
    await h.close()
  }
}

beforeAll(async () => {
  LspManager.prototype.stopAll = async function (this: LspManager) {
    stopCalls++
    return originalStopAll.call(this)
  }
  state = await mkdtemp(path.join(tmpdir(), "es-lsp-197-state-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: {
      "README.md": "# lsp audit 197\n",
      ".gitignore": "node_modules/\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, module: "NodeNext", target: "ES2022" },
        include: ["src"],
      }),
      "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b\n}\n",
    },
  })
  await mkdir(path.join(h.directory, "node_modules/.bin"), { recursive: true })
  await symlink(TYPESCRIPT, path.join(h.directory, "node_modules/typescript"), "dir")
  await symlink(path.join(TYPESCRIPT, "bin/tsc"), path.join(h.directory, "node_modules/.bin/tsc"))
}, 60_000)
afterAll(async () => {
  await closeOnce().catch(() => undefined)
  LspManager.prototype.stopAll = originalStopAll
  await rm(state, { recursive: true, force: true })
})

describe("LSP diagnostics end to end (#197)", () => {
  test("a type-error edit reaches the agent and starts the workspace server", async () => {
    const { tools: outcomes } = await h.run(
      call("write", {
        path: "src/main.ts",
        content: 'import { add } from "./math.js"\nexport const bad: string = add(1, 2)\n',
      }),
    )
    expect(outcomes[0]?.status).toBe("completed")
    expect(outcomes[0]?.text).toContain("<diagnostics>")
    expect(outcomes[0]?.text).toContain("src/main.ts:2")
    expect(outcomes[0]?.text).toContain("not assignable to type 'string'")
    const rpc = (h.opencode as any).rpc(EsRpc)
    const lsp = await rpc.lspState({}, { location: h.location })
    expect(lsp.enabled).toBe(true)
    const typescript = (lsp.servers as Array<any>).find((server) => server.id === "typescript")
    expect(typescript?.available).toBe(true)
    expect(typescript?.command).toContain("tsc")
    expect(typescript?.running).toBeGreaterThanOrEqual(1)
  }, 60_000)

  test("the /lsp server command reports status lines", async () => {
    const created = await (h.opencode.sessions as any).create({ location: h.location })
    const sessionID: string = created.id
    await (h.opencode.sessions as any).command({ sessionID, name: "lsp", text: "" })
    await (h.opencode.sessions as any).wait({ sessionID })
    const context = await (h.opencode.sessions as any).context({ sessionID })
    const text: string = context
      .filter((message: any) => message?.type === "synthetic")
      .map((message: any) => String(message?.text ?? ""))
      .join("\n")
    const lines = text.split("\n")
    expect(lines[0]).toBe("LSP is on.")
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      if (line.startsWith("! ")) continue
      if (line === "LSP is on.") continue
      expect(line).toMatch(/^\S+ \[[^\]]+\]: /)
    }
    const typescript = lines.find((line) => line.startsWith("typescript ["))
    expect(typescript).toContain("available (")
    expect(typescript).toContain("tsc")
    expect(typescript).toContain("--lsp")
    // The previous test's edit started the workspace server in this project.
    expect(typescript).toContain("running for 1 root")
  }, 60_000)

  // NOTE (bug #275, lifecycle half): servers are killed on plugin unload only;
  // no session-end hook exists (between sessions only the idle sweeper reaps).
  // Session-end kill is untested here by design — do NOT change lifecycle.
  test("host close stops the language servers (stopAll on unload)", async () => {
    expect(stopCalls).toBe(0)
    await closeOnce()
    expect(stopCalls).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

describe("after-edit diagnostics for an lsp:none seat (#277 fixed)", () => {
  test("the injector stays silent for a seat with no LSP tools", async () => {
    // FIXED (#277.2): the injector is scoped to seats whose registry entry
    // allows LSP — the designer seat is lsp:"none", so its completed writes
    // pass through untouched. (The old leak this pinned is gone.)
    expect(agentSpec("designer")?.lsp).toBe("none")
    const { createPolicyHooks } = await import("../src/policy.ts")
    const root = await mkdtemp(path.join(tmpdir(), "es-lsp-197-none-"))
    try {
      const hooks = createPolicyHooks({
        root,
        options: { lspAfterEdit: true },
        lsp: {
          diagnostics: async () => [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              message: "Type 'number' is not assignable to type 'string'.",
            },
          ],
        },
      } as any)
      const event = {
        tool: "write",
        agent: "designer",
        id: "t1",
        input: { path: "src/main.ts" },
        status: "completed",
        result: { content: "ok" },
      }
      await hooks.after(event as any)
      const content = String((event.result as any)?.content ?? "")
      expect(content).toBe("ok")
      expect(content).not.toContain("<diagnostics>")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an unavailable server appends nothing (control)", async () => {
    const { createPolicyHooks } = await import("../src/policy.ts")
    const root = await mkdtemp(path.join(tmpdir(), "es-lsp-197-none-"))
    try {
      const hooks = createPolicyHooks({
        root,
        options: { lspAfterEdit: true },
        lsp: { diagnostics: async () => ({ unavailable: "no language server handles .md" }) },
      } as any)
      const event = {
        tool: "write",
        agent: "designer",
        id: "t1",
        input: { path: ".factory/design/notes/idea.md" },
        status: "completed",
        result: { content: "ok" },
      }
      await hooks.after(event as any)
      expect((event.result as any)?.content).toBe("ok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
