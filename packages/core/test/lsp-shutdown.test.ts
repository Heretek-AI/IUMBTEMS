// Audit #197 integration tests (core side): the workspace TypeScript server
// reaches diagnostics through the manager, and stopAll shuts the running
// servers down. Same tsc fixture seam as lsp.test.ts; no binaries run directly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LspManager } from "../src/index.ts"

const TYPESCRIPT = path.resolve(import.meta.dir, "../../../node_modules/typescript")

let root: string
let state: string
let manager: LspManager
const write = async (file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-lsp-shutdown-"))
  state = await mkdtemp(path.join(tmpdir(), "es-lsp-shutdown-state-"))
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

describe("LspManager shutdown (#197)", () => {
  test("diagnostics start the workspace server and stopAll shuts it down", async () => {
    const diagnostics = await manager.diagnostics("src/main.ts", { maxWaitMs: 20_000 })
    expect(Array.isArray(diagnostics)).toBe(true)
    const messages = (diagnostics as any[]).map((item) => `${item.range.start.line + 1}: ${item.message}`)
    expect(messages.join("\n")).toContain("4: Type 'number' is not assignable to type 'string'")
    const running = (await manager.status()).running
    expect(running.some((entry) => entry.id === "typescript" && entry.ready)).toBe(true)
    await manager.stopAll()
    expect((await manager.status()).running).toEqual([])
  }, 60_000)

  test("stopAll is idempotent and the next diagnostics restarts the server lazily", async () => {
    await manager.stopAll()
    expect((await manager.status()).running).toEqual([])
    const diagnostics = await manager.diagnostics("src/main.ts", { maxWaitMs: 20_000 })
    expect(Array.isArray(diagnostics)).toBe(true)
    expect(JSON.stringify(diagnostics)).toContain("not assignable to type 'string'")
    expect((await manager.status()).running.some((entry) => entry.id === "typescript" && entry.ready)).toBe(true)
  }, 60_000)
})
