// Issue #198: the plugin registers additively — setup writes no project-tree
// files. The "no files written" wording is qualified (bug filed): the engine
// key IS written, but to the masked state dir, never the project. So this
// asserts the location contract, not absence:
//   1. right after plugin load (no session activity), the project tree holds
//      exactly the initial files;
//   2. after agent activity forces sealed writes, engine.key exists in the
//      passed state dir (and is a real key), while no engine.key exists
//      anywhere under the project tree.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engineKeyPath } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const initialFiles = { "README.md": "# demo\n", ".gitignore": "node_modules/\n" }

/** Project-tree entries below `dir`, excluding the git internals. */
async function projectTree(dir: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["find", dir, "-mindepth", "1", "-not", "-path", `${dir}/.git`, "-not", "-path", `${dir}/.git/*`],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code).toBe(0)
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((file) => path.relative(dir, file))
    .sort()
}

/** engine.key files anywhere under `dir` (project tree must hold none). */
async function engineKeysUnder(dir: string): Promise<string[]> {
  const proc = Bun.spawn(["find", dir, "-name", "engine.key", "-not", "-path", `${dir}/.git/*`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code).toBe(0)
  return stdout.split("\n").filter(Boolean).sort()
}

let h: Harness
let state: string
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-plugin-tree-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: initialFiles,
  })
}, 120_000)
afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

test("plugin load writes no project-tree files", async () => {
  // No session has run yet: this diffs the tree before/after plugin load.
  expect(await projectTree(h.directory)).toEqual(Object.keys(initialFiles).sort())
  expect(await engineKeysUnder(h.directory)).toEqual([])
})

test("engine.key lives in the state dir, never the project tree", async () => {
  // A factory turn forces sealed writes (spend/seat tracking), which mint the
  // engine key when absent.
  await h.run("hello", { agent: "factory" })
  const key = engineKeyPath(state)
  expect(await Bun.file(key).exists()).toBe(true)
  expect((await Bun.file(key).arrayBuffer()).byteLength).toBeGreaterThanOrEqual(32)
  expect(await engineKeysUnder(h.directory)).toEqual([])
})
