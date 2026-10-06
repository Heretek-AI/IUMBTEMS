// LSP runtime against real language servers (native TypeScript 7 `tsc --lsp`,
// gopls) plus config resolution and the pinned installer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  consent,
  installServer,
  LspManager,
  recordConsent,
  resolveLspConfig,
  type ServerSpec,
  sri,
} from "../src/index.ts"

const TYPESCRIPT = path.resolve(import.meta.dir, "../../../node_modules/typescript")
const hasGo = Bun.which("gopls") !== null && Bun.which("go") !== null

let root: string
let state: string
let manager: LspManager
const write = async (file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-lsp-"))
  state = await mkdtemp(path.join(tmpdir(), "es-lsp-state-"))
  await write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", noEmit: true },
      include: ["src"],
    }),
  )
  await mkdir(path.join(root, "node_modules"), { recursive: true })
  await symlink(TYPESCRIPT, path.join(root, "node_modules/typescript"), "dir")
  await mkdir(path.join(root, "node_modules/.bin"), { recursive: true })
  await symlink(path.join(TYPESCRIPT, "bin/tsc"), path.join(root, "node_modules/.bin/tsc"))
  await write("src/math.ts", "export function add(a: number, b: number): number {\n  return a + b\n}\n")
  await write(
    "src/main.ts",
    'import { add } from "./math.js"\n\nconst total: number = add(1, 2)\nconst wrong: string = total\nexport { wrong }\n',
  )
  manager = new LspManager({ root, stateDir: state, configFiles: [path.join(root, "opencode.json")] })
}, 30_000)

afterAll(async () => {
  await manager?.stopAll()
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

describe("TypeScript (native tsc --lsp)", () => {
  test("resolves to the workspace TypeScript 7 binary and reports diagnostics", async () => {
    const server = (await manager.settings()).servers.find((item) => item.id === "typescript")!
    expect(await manager.command(server, root)).toEqual([path.join(root, "node_modules/.bin/tsc"), "--lsp", "--stdio"])
    const diagnostics = await manager.diagnostics("src/main.ts", { maxWaitMs: 20_000 })
    expect(Array.isArray(diagnostics)).toBe(true)
    const messages = (diagnostics as any[]).map((item) => `${item.range.start.line + 1}: ${item.message}`)
    expect(messages.join("\n")).toContain("4: Type 'number' is not assignable to type 'string'")
  }, 60_000)

  test("definition, references, hover, symbols and rename", async () => {
    const found = await manager.clientFor("src/main.ts")
    if ("unavailable" in found) throw new Error(found.unavailable)
    const main = path.join(root, "src/main.ts")
    const definition = await found.client.definition(main, 3, 23)
    expect(definition[0]?.uri).toEndWith("/src/math.ts")
    const references = await found.client.references(path.join(root, "src/math.ts"), 1, 17)
    expect(references.length).toBeGreaterThanOrEqual(2)
    const hover = await found.client.hover(main, 3, 23)
    expect(JSON.stringify(hover?.contents)).toContain("add")
    const symbols = await found.client.documentSymbols(path.join(root, "src/math.ts"))
    expect(JSON.stringify(symbols)).toContain('"add"')
    const edit = await found.client.rename(path.join(root, "src/math.ts"), 1, 17, "sum")
    expect(JSON.stringify(edit)).toContain("sum")
  }, 60_000)
})

describe.skipIf(!hasGo)("Go (gopls)", () => {
  test("reports a type error", async () => {
    await write("go.mod", "module example.com/demo\n\ngo 1.22\n")
    await write("main.go", 'package main\n\nfunc main() {\n\tvar x int = "nope"\n\t_ = x\n}\n')
    const diagnostics = await manager.diagnostics("main.go", { maxWaitMs: 30_000 })
    expect(JSON.stringify(diagnostics)).toContain("cannot use")
  }, 60_000)
})

describe("config and availability", () => {
  test("the v2 lsp key disables or overrides servers", async () => {
    const config = path.join(root, "cfg.json")
    await writeFile(
      config,
      JSON.stringify({
        lsp: { typescript: { disabled: true }, mylang: { command: ["mylang-ls"], extensions: [".my"] } },
      }),
    )
    const resolved = await resolveLspConfig(root, [config])
    expect(resolved.servers.some((server) => server.id === "typescript")).toBe(false)
    expect(resolved.servers.find((server) => server.id === "mylang")?.extensions).toEqual([".my"])
    await writeFile(config, JSON.stringify({ lsp: false }))
    expect((await resolveLspConfig(root, [config])).enabled).toBe(false)
  })

  test("a missing server explains how a human installs it", async () => {
    await write("app.py", "x = 1\n")
    const result = await manager.diagnostics("app.py")
    if (Bun.which("pyright-langserver")) return
    expect((result as { unavailable: string }).unavailable).toContain("es lsp install pyright")
  })
})

describe("pinned installer", () => {
  test("needs consent, then refuses a tarball whose sha512 does not match the pin", async () => {
    const fakeNpm = path.join(state, "npm")
    await writeFile(
      fakeNpm,
      `#!/bin/sh\nif [ "$1" = pack ]; then dest=$4; printf 'tampered' > "$dest/pkg-1.0.0.tgz"; echo '[{"filename":"pkg-1.0.0.tgz"}]'; exit 0; fi\nexit 1\n`,
    )
    await chmod(fakeNpm, 0o755)
    const server: ServerSpec = {
      id: "fake-ls",
      command: ["fake-ls"],
      extensions: [".fake"],
      rootMarkers: [],
      install: {
        kind: "npm",
        packages: [{ name: "pkg", version: "1.0.0", integrity: sri(new TextEncoder().encode("genuine")) }],
        bin: "fake-ls",
      },
      source: "builtin",
    }
    await expect(installServer(server, { stateDir: state, npm: fakeNpm })).rejects.toThrow("consent")
    await recordConsent("fake-ls", true, state)
    expect(await consent("fake-ls", state)).toBe(true)
    await expect(installServer(server, { stateDir: state, npm: fakeNpm })).rejects.toThrow("integrity mismatch")
  })
})
