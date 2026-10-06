import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { atomicWrite, relativeInside, withLock } from "../src/util/fs.ts"
import { matchGlob } from "../src/util/glob.ts"
import { canonicalJson, hashJson } from "../src/util/hash.ts"
import { parseJsonc } from "../src/util/jsonc.ts"
import { run, scrubbedEnv, splitCommand } from "../src/util/proc.ts"
import { parseFrontmatter, parseYaml, stringifyFrontmatter } from "../src/util/yaml.ts"

describe("hash", () => {
  test("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }))
  })
})

describe("glob", () => {
  test.each([
    ["src/a.ts", "src/**", true],
    ["src/deep/a.ts", "src/**/*.ts", true],
    ["src/a.ts", "src/**/*.ts", true],
    ["src/deep/a.ts", "src/*.ts", false],
    [".factory/specs/p1/GOAL.md", ".factory/**", true],
    ["docs/x.md", "{docs,README}/**", true],
    ["lib/a.js", "src/**", false],
  ])("%s ~ %s = %p", (file, glob, expected) => expect(matchGlob(file, glob)).toBe(expected))
})

describe("jsonc", () => {
  test("strips comments and trailing commas but not string content", () => {
    expect(parseJsonc('{ // c\n "a": "x,}// y", /* z */ "b": [1, 2,], }')).toEqual({ a: "x,}// y", b: [1, 2] })
  })
})

describe("yaml subset", () => {
  test("maps, lists, inline values and block scalars", () => {
    const doc = parseYaml(
      'id: p1\ntitle: "Add: colon"\nflags: [a, b]\ncriteria:\n  - id: c1\n    kind: test\n  - id: c2\n    kind: command\nnotes: |\n  line one\n  line two\nempty:\n',
    )
    expect(doc).toEqual({
      id: "p1",
      title: "Add: colon",
      flags: ["a", "b"],
      criteria: [
        { id: "c1", kind: "test" },
        { id: "c2", kind: "command" },
      ],
      notes: "line one\nline two\n",
      empty: null,
    })
  })
  test("frontmatter round-trips", () => {
    const data = { id: "p1", count: 3, ok: true, tags: ["x", "y z"], nested: { a: "b" } }
    const parsed = parseFrontmatter(stringifyFrontmatter(data, "# Body\n"))
    expect(parsed.data).toEqual(data)
    expect(parsed.body).toBe("# Body\n")
  })
  test("rejects tabs and duplicate keys", () => {
    expect(() => parseYaml("a:\n\tb: 1")).toThrow()
    expect(() => parseYaml("a: 1\na: 2")).toThrow()
  })
})

describe("fs", () => {
  test("atomicWrite and lock serialize concurrent writers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-core-"))
    const file = path.join(dir, "counter")
    await atomicWrite(file, "0")
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withLock(file, async () => {
          const value = Number(await readFile(file, "utf8"))
          await atomicWrite(file, String(value + 1))
        }),
      ),
    )
    expect(await readFile(file, "utf8")).toBe("10")
  })
  test("relativeInside refuses escapes", () => {
    expect(relativeInside("/repo", "/repo/src/a.ts")).toBe("src/a.ts")
    expect(relativeInside("/repo", "/etc/passwd")).toBeUndefined()
  })
})

describe("proc", () => {
  test("scrubs secret-looking variables unless explicitly passed", () => {
    const env = scrubbedEnv({}, [], { PATH: "/bin", GITHUB_TOKEN: "x", HOME: "/h" } as any)
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" })
  })
  test("splitCommand honours quotes", () => {
    expect(splitCommand(`npx tsc --noEmit -p "a b/tsconfig.json"`)).toEqual(["npx", "tsc", "--noEmit", "-p", "a b/tsconfig.json"])
  })
  test("times out and caps output", async () => {
    const slow = await run(["sh", "-c", "sleep 5"], { cwd: tmpdir(), timeoutMs: 200 })
    expect(slow.timedOut).toBe(true)
    const loud = await run(["sh", "-c", "yes | head -c 5000"], { cwd: tmpdir(), maxOutputBytes: 100 })
    expect(loud.stdout.length).toBe(100)
    expect(loud.truncated).toBe(true)
  })
})
