// `es rebase cascade` CLI verb (#165): usage errors and a green cascade.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

let root: string
let state: string
const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}
async function run(argv: string[]) {
  const printed: string[] = []
  const code = await main(argv, { print: (text) => printed.push(text), confirm: pipe, cwd: root, stateDir: state })
  return { code, out: printed.join("\n") }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-cli-rb-"))
  state = await mkdtemp(path.join(tmpdir(), "es-cli-rb-state-"))
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# x\n")
  await git("add", "-A")
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

describe("es rebase cascade (#165)", () => {
  test("missing flags print usage with exit 2", async () => {
    const result = await run(["rebase", "cascade", "--from", "a"])
    expect(result.code).toBe(2)
    expect(result.out).toContain("Usage: es rebase cascade --from <branch> --to <branch>")
  })

  test("a clean cascade moves the target and reports SHAs", async () => {
    const commitFile = async (file: string, text: string, message: string) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), text)
      await git("add", "-A")
      await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message)
    }
    await commitFile("fix.txt", "upstream\n", "upstream fix")
    await git("branch", "from-br", "HEAD")
    await git("reset", "-q", "--hard", "HEAD~1")
    await commitFile("feat.txt", "downstream\n", "downstream work")
    await git("branch", "to-br", "HEAD")
    await git("checkout", "-q", "main")
    const result = await run(["rebase", "cascade", "--from", "from-br", "--to", "to-br"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("Rebased to-br onto from-br")
  })

  test("`es rebase --help` prints the rebase usage", async () => {
    const result = await run(["rebase", "--help"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("rebase cascade --from <branch> --to <branch>")
  })

  test("audit #332: cascading onto main is refused from the CLI", async () => {
    // Both directions refuse: main advances through the human release flow
    // only (core RebaseError surfaces as exit 1, branches unmoved).
    await writeFile(path.join(root, "a.txt"), "x\n")
    await git("add", "-A")
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a")
    await git("branch", "to-br", "HEAD")
    const onto = await run(["rebase", "cascade", "--from", "to-br", "--to", "main"])
    expect(onto.code).toBe(1)
    expect(onto.out).toMatch(/main/i)
    const from = await run(["rebase", "cascade", "--from", "main", "--to", "to-br"])
    expect(from.code).toBe(1)
    expect(from.out).toMatch(/main/i)
  })

  test("audit #332: --no-verify pins the skip semantics (post-rebase tests only)", async () => {
    // A fast-forward onto invalid JSON fails the default marker/JSON sanity
    // but succeeds with --no-verify: the flag replaces runTests with
    // () => true (packages/cli/src/main.ts), skipping ONLY the green-tests
    // gate — main refusal and conflict handling still apply.
    await git("branch", "to-br", "HEAD")
    await writeFile(path.join(root, "bad.json"), "{invalid json")
    await git("add", "-A")
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "bad json")
    await git("branch", "from-br", "HEAD")
    await git("checkout", "-q", "main")
    const strict = await run(["rebase", "cascade", "--from", "from-br", "--to", "to-br"])
    expect(strict.code).toBe(1)
    expect(strict.out).toMatch(/post-rebase tests failed|Cascade failed/i)
    const skipped = await run(["rebase", "cascade", "--from", "from-br", "--to", "to-br", "--no-verify"])
    expect(skipped.code).toBe(0)
    expect(skipped.out).toContain("Rebased to-br onto from-br")
  })
})
