// SemanticRebaseManager: cascade rebases across stack branches (#165).
// Upstream fixes replay downstream automatically; TS import and package.json
// conflicts resolve AST-aware; a failing post-rebase test run restores the
// previous SHA (monotonic guarantee).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import * as Git from "../src/worktree/git.ts"
import { cascadeRebase, mergePackageJson, mergeTypeScriptImports, resolveConflict } from "../src/worktree/rebase.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo("es-rb-")
})
afterEach(() => fx.cleanup())

const commitFile = async (root: string, file: string, text: string, message: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
  return Git.commitAll(root, message)
}

describe("mergeTypeScriptImports", () => {
  test("unions named specifiers from the same module and dedupes", () => {
    const ours = `import { a } from "./m"\nimport x from "lib"\n`
    const theirs = `import { b, a } from "./m"\nimport x from "lib"\n`
    const merged = mergeTypeScriptImports(ours, theirs)
    expect(merged).toContain(`import { a, b } from "./m"`)
    expect(merged).toContain(`import x from "lib"`)
    expect(merged!.split("\n").filter((line) => line.includes('"./m"'))).toHaveLength(1)
  })

  test("keeps disjoint modules from both sides", () => {
    const merged = mergeTypeScriptImports(`import { a } from "./a"\n`, `import { b } from "./b"\n`)
    expect(merged).toContain(`from "./a"`)
    expect(merged).toContain(`from "./b"`)
  })

  test("merges default-plus-named imports explicitly", () => {
    const merged = mergeTypeScriptImports(`import x, { a } from "./m"\n`, `import x, { b } from "./m"\n`)
    expect(merged).toContain(`import x, { a, b } from "./m"`)
  })

  test("hostile input terminates with a decision instead of hanging (ReDoS)", () => {
    const hostile = `import ${"a\t".repeat(2000)}from"\n`
    expect(mergeTypeScriptImports(hostile, `import { b } from "./m"\n`)).toBeUndefined()
  })
  test("bails on multi-line imports instead of guessing", () => {
    expect(mergeTypeScriptImports(`import {\n  a,\n} from "./m"\n`, `import { b } from "./m"\n`)).toBeUndefined()
  })

  test("refuses to merge clashing defaults or mixed type/value imports", () => {
    expect(mergeTypeScriptImports(`import a from "./m"\n`, `import b from "./m"\n`)).toBeUndefined()
    expect(mergeTypeScriptImports(`import type { a } from "./m"\n`, `import { b } from "./m"\n`)).toBeUndefined()
    expect(mergeTypeScriptImports(`import type { a } from "./m"\n`, `import type { a, b } from "./m"\n`)).toContain(
      "{ a, b }",
    )
  })
})

describe("mergePackageJson", () => {
  test("unions dependencies and picks the higher semver on conflict", () => {
    const ours = JSON.stringify({ name: "x", dependencies: { a: "^1.2.0", b: "^2.0.0" } })
    const theirs = JSON.stringify({ name: "x", dependencies: { a: "^1.9.0", c: "^3.0.0" } })
    const merged = JSON.parse(mergePackageJson(ours, theirs)!)
    expect(merged.dependencies).toEqual({ a: "^1.9.0", b: "^2.0.0", c: "^3.0.0" })
  })

  test("bails on invalid JSON", () => {
    expect(mergePackageJson("{nope", "{}")).toBeUndefined()
  })
})

describe("resolveConflict", () => {
  test("dispatches by extension and refuses unknown files", () => {
    expect(resolveConflict("src/x.ts", `import { a } from "./m"\n`, `import { b } from "./m"\n`)).toContain("b")
    expect(resolveConflict("notes.txt", "a\n", "b\n")).toBeUndefined()
  })
})

describe("cascadeRebase", () => {
  /** From-base/upstream/downstream stack: from-br carries the fix, to-br the downstream work. */
  const divergedPair = async (file: string, base: string, upstream: string, downstream: string) => {
    await commitFile(fx.root, file, base, "base")
    await Git.git(fx.root, ["branch", "stack-base", "HEAD"])
    await commitFile(fx.root, file, upstream, "upstream")
    await Git.git(fx.root, ["branch", "-f", "from-br", "HEAD"])
    await Git.git(fx.root, ["checkout", "-q", "stack-base"])
    await commitFile(fx.root, file, downstream, "downstream")
    await Git.git(fx.root, ["branch", "to-br", "HEAD"])
    await Git.git(fx.root, ["checkout", "-q", "main"])
  }

  /** Linear stack: from-br is one commit ahead of main, to-br one more on other files. */
  const linearPair = async (upstreamFile: string, downstreamFile: string) => {
    await commitFile(fx.root, upstreamFile, "upstream\n", "upstream")
    await Git.git(fx.root, ["branch", "from-br", "HEAD"])
    await Git.git(fx.root, ["reset", "-q", "--hard", "HEAD~1"])
    await commitFile(fx.root, downstreamFile, "downstream\n", "downstream")
    await Git.git(fx.root, ["branch", "to-br", "HEAD"])
    await Git.git(fx.root, ["checkout", "-q", "main"])
  }

  test("clean cascade replays downstream commits onto the upstream tip", async () => {
    await linearPair("fix.txt", "feat.txt")

    const before = await Git.revParse(fx.root, "to-br")
    const result = await cascadeRebase(fx.root, {
      from: "from-br",
      to: "to-br",
      runTests: async () => true,
    })
    expect(result.ok).toBe(true)
    expect(result.rolledBack).toBe(false)
    expect(result.previousSha).toBe(before)
    // Both commits are reachable from the rebased tip, linearly.
    const log = (await Git.git(fx.root, ["log", "--format=%s", "to-br"])).stdout
    expect(log).toContain("upstream")
    expect(log).toContain("downstream")
    expect((await Git.git(fx.root, ["log", "--format=%s", "from-br"])).stdout).not.toContain("downstream")
  })

  test("conflicting imports auto-merge and the cascade succeeds", async () => {
    await divergedPair(
      "src/x.ts",
      `import { shared } from "./m"\nexport const v = 1\n`,
      `import { shared, fix } from "./m"\nexport const v = 1\n`,
      `import { shared, feat } from "./m"\nexport const v = 1\n`,
    )

    const result = await cascadeRebase(fx.root, { from: "from-br", to: "to-br", runTests: async () => true })
    expect(result.ok).toBe(true)
    expect(result.resolutions).toContain("src/x.ts")
    const text = (await Git.git(fx.root, ["show", "to-br:src/x.ts"])).stdout
    expect(text).toContain("shared")
    expect(text).toContain("fix")
    expect(text).toContain("feat")
  })

  test("a failing post-rebase test run restores the previous SHA", async () => {
    await linearPair("a.txt", "b.txt")
    const before = await Git.revParse(fx.root, "to-br")

    const result = await cascadeRebase(fx.root, {
      from: "from-br",
      to: "to-br",
      runTests: async () => false,
    })
    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(await Git.revParse(fx.root, "to-br")).toBe(before)
  })

  test("an unresolvable conflict aborts with the target untouched", async () => {
    await divergedPair("code.txt", "line one\n", "upstream line\n", "downstream line\n")
    const before = await Git.revParse(fx.root, "to-br")

    const result = await cascadeRebase(fx.root, { from: "from-br", to: "to-br", runTests: async () => true })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/conflict/i)
    expect(await Git.revParse(fx.root, "to-br")).toBe(before)
  })

  test("cascades involving main are refused", async () => {
    await expect(cascadeRebase(fx.root, { from: "main", to: "to-br" })).rejects.toThrow(/main/)
    await expect(cascadeRebase(fx.root, { from: "to-br", to: "main" })).rejects.toThrow(/main/)
  })

  test("a target that already contains the fix is a no-op success", async () => {
    await commitFile(fx.root, "a.txt", "x\n", "one")
    await Git.git(fx.root, ["branch", "from-br", "HEAD"])
    await commitFile(fx.root, "b.txt", "y\n", "two")
    await Git.git(fx.root, ["branch", "to-br", "HEAD"])
    await Git.git(fx.root, ["checkout", "-q", "main"])
    const before = await Git.revParse(fx.root, "to-br")
    const result = await cascadeRebase(fx.root, { from: "from-br", to: "to-br", runTests: async () => true })
    expect(result.ok).toBe(true)
    expect(result.newSha).toBe(before)
    expect(result.rolledBack).toBe(false)
  })

  test("a fast-forward moves only on green tests", async () => {
    await commitFile(fx.root, "a.txt", "x\n", "one")
    await Git.git(fx.root, ["branch", "to-br", "HEAD"])
    await commitFile(fx.root, "b.txt", "y\n", "two")
    await Git.git(fx.root, ["branch", "from-br", "HEAD"])
    await Git.git(fx.root, ["checkout", "-q", "main"])
    const before = await Git.revParse(fx.root, "to-br")
    const tip = await Git.revParse(fx.root, "from-br")
    const green = await cascadeRebase(fx.root, { from: "from-br", to: "to-br", runTests: async () => true })
    expect(green.ok).toBe(true)
    expect(green.newSha).toBe(tip)
    await Git.git(fx.root, ["branch", "-f", "to-br", before])
    const red = await cascadeRebase(fx.root, { from: "from-br", to: "to-br", runTests: async () => false })
    expect(red.ok).toBe(false)
    expect(red.rolledBack).toBe(true)
    expect(await Git.revParse(fx.root, "to-br")).toBe(before)
  })

  test("audit #332: an unhandled-type conflict aborts with both branches untouched", async () => {
    // notes.txt is neither TS nor JSON: resolveConflict bails (a human must
    // rebase by hand), so the cascade fails without moving either branch.
    await divergedPair("notes.txt", "line one\n", "upstream line\n", "downstream line\n")
    const beforeTo = await Git.revParse(fx.root, "to-br")
    const beforeFrom = await Git.revParse(fx.root, "from-br")
    expect(resolveConflict("notes.txt", "upstream line\n", "downstream line\n")).toBeUndefined()

    const result = await cascadeRebase(fx.root, { from: "from-br", to: "to-br", runTests: async () => true })
    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.reason).toMatch(/conflict|human/i)
    expect(await Git.revParse(fx.root, "to-br")).toBe(beforeTo)
    expect(await Git.revParse(fx.root, "from-br")).toBe(beforeFrom)
  })
})
