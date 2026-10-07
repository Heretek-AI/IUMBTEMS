// LSP on the real host: post-edit diagnostics, navigation tools, per-agent
// LSP permissions, and the touched-scope diagnostics gate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness, lastAgentRequest } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const TYPESCRIPT = path.resolve(import.meta.dir, "../../../node_modules/typescript")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const tools = (h: Harness) => (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)

let state: string
let h: Harness
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-lsp-host-state-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: {
      "README.md": "# lsp\n",
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
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("LSP on the real host", () => {
  test("an edit that introduces a type error gets the diagnostics appended", async () => {
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
  }, 60_000)

  test("navigation tools answer through the language server", async () => {
    const { tools: outcomes } = await h.run(
      `${call("lsp_definition", { path: "src/main.ts", line: 2, column: 28 })} ${call("lsp_hover", { path: "src/math.ts", line: 1, column: 17 })}`,
    )
    expect(outcomes[0]?.text).toContain("src/math.ts:1")
    expect(outcomes[1]?.text).toContain("add")
  }, 60_000)

  test("per-agent LSP access: QA can navigate but not rename; the grill has no LSP tools", async () => {
    await h.run("hello", { agent: "es-qa-functional" })
    expect(tools(h)).toContain("lsp_definition")
    expect(tools(h)).not.toContain("lsp_rename")
    await h.run("hello", { agent: "grill" })
    expect(tools(h).some((name) => name.startsWith("lsp_"))).toBe(false)
  })

  test("the touched-scope gate reports language-server errors", async () => {
    const { tools: outcomes } = await h.run(call("es_gates_run", { files: ["src/main.ts"] }))
    expect(outcomes[0]?.text).toContain("lsp/")
    expect(outcomes[0]?.text).toContain("src/main.ts:2")
  }, 60_000)
})
