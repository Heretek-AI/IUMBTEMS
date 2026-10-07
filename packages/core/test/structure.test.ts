// The structural index: pinned tree-sitter grammars (cache, integrity, offline
// fallback), per-language extraction, the import graph and affected tests.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  affectedTests,
  buildImportGraph,
  dependentsOf,
  extractStructure,
  extractWithRegex,
  GRAMMARS,
  type GrammarId,
  grammarCacheDir,
  grammarFor,
  loadGrammar,
  resetGrammars,
  untarFile,
} from "../src/index.ts"

const dirs: string[] = []
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- grammars

describe("grammar selection and archive extraction", () => {
  test("extensions map to grammars; unknown extensions return undefined", () => {
    expect(grammarFor("src/a.ts")).toBe("typescript")
    expect(grammarFor("a.tsx")).toBe("tsx")
    expect(grammarFor("a.mjs")).toBe("javascript")
    expect(grammarFor("pkg/mod.py")).toBe("python")
    expect(grammarFor("cmd/main.go")).toBe("go")
    expect(grammarFor("README.md")).toBeUndefined()
    expect(grammarFor("a.rs")).toBeUndefined()
  })

  test("every pin carries an npm tarball, an SRI and a wasm sha256", () => {
    for (const pin of Object.values(GRAMMARS)) {
      expect(pin.npm.length).toBeGreaterThan(0)
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(pin.integrity).toMatch(/^sha512-/)
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(pin.file.endsWith(".wasm")).toBe(true)
    }
  })

  test("untarFile extracts a named member, honours prefixes and reports misses", () => {
    const enc = new TextEncoder()
    const entry = (name: string, content: string) => {
      const body = enc.encode(content)
      const header = new Uint8Array(512)
      header.set(enc.encode(name), 0)
      header.set(enc.encode("0000644"), 100)
      header.set(enc.encode(`${body.length.toString(8).padStart(11, "0")}\0`), 124)
      header.set(enc.encode("0000000"), 108)
      header.set(enc.encode("0000000"), 116)
      header.set(enc.encode("00000000000"), 136)
      header.set(enc.encode("ustar"), 257)
      const out = new Uint8Array(512 + Math.ceil(body.length / 512) * 512)
      out.set(header, 0)
      out.set(body, 512)
      return out
    }
    const archive = (chunks: Uint8Array[]) => {
      const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    }
    const tar = archive([entry("package/a.wasm", "wasm-a"), entry("package/b.wasm", "wasm-b")])
    expect(new TextDecoder().decode(untarFile(tar, "a.wasm")!)).toBe("wasm-a")
    expect(new TextDecoder().decode(untarFile(tar, "b.wasm")!)).toBe("wasm-b")
    expect(untarFile(archive([entry("package/a.wasm", "x"), new Uint8Array(512)]), "missing.wasm")).toBeUndefined()

    // The ustar prefix field is joined with the name.
    const prefixed = new Uint8Array(512)
    prefixed.set(enc.encode("file.wasm"), 0)
    prefixed.set(enc.encode("pkg/sub\0"), 345)
    prefixed.set(enc.encode("0000003\0"), 124)
    expect(new TextDecoder().decode(untarFile(archive([prefixed, new Uint8Array(512)]), "file.wasm")!)).toBe("\0\0\0")
  })

  test("the cache directory honours ES_GRAMMAR_DIR and XDG_CACHE_HOME", () => {
    const saved = { dir: process.env.ES_GRAMMAR_DIR, xdg: process.env.XDG_CACHE_HOME }
    try {
      process.env.ES_GRAMMAR_DIR = "/tmp/custom-grammars"
      expect(grammarCacheDir()).toBe("/tmp/custom-grammars")
      delete process.env.ES_GRAMMAR_DIR
      process.env.XDG_CACHE_HOME = "/tmp/xdg"
      expect(grammarCacheDir()).toBe("/tmp/xdg/epistemic-swarm/grammars")
    } finally {
      if (saved.dir === undefined) delete process.env.ES_GRAMMAR_DIR
      else process.env.ES_GRAMMAR_DIR = saved.dir
      if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = saved.xdg
    }
  })
})

describe("grammar cache integrity and fallback", () => {
  beforeEach(() => resetGrammars())
  afterEach(() => resetGrammars())

  test("offline without a cache falls back to the regex scanner", async () => {
    const cache = await tmp("es-grammars-")
    await expect(loadGrammar("typescript", { cacheDir: cache, offline: true })).rejects.toThrow(/not cached/)
    const structure = await extractStructure("a.ts", "export const x = 1\n", { cacheDir: cache, offline: true })
    expect(structure?.parser).toBe("regex")
    expect(structure?.symbols.map((symbol) => symbol.name)).toContain("x")
  })

  test("a cached wasm with the wrong bytes is refused (a tampered cache is not loaded)", async () => {
    const cache = await tmp("es-grammars-")
    const pin = GRAMMARS.javascript
    const file = path.join(cache, `${pin.npm}@${pin.version}`, pin.file)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "not the real wasm")
    await expect(loadGrammar("javascript", { cacheDir: cache, offline: true })).rejects.toThrow(/not cached/)
    const structure = await extractStructure("a.js", "import { x } from './x.js'\n", { cacheDir: cache, offline: true })
    expect(structure?.parser).toBe("regex")
    expect(structure?.imports[0]?.specifier).toBe("./x.js")
  })

  test("a download whose tarball fails its pinned integrity is refused", async () => {
    const cache = await tmp("es-grammars-")
    const fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof globalThis.fetch
    await expect(loadGrammar("python", { cacheDir: cache, fetch })).rejects.toThrow(/pinned integrity/)
    // The failure is latched, so a second attempt does not re-hit the network.
    await expect(loadGrammar("python", { cacheDir: cache, fetch })).rejects.toThrow(/pinned integrity/)
  })

  test("a network failure falls back to regex and is latched", async () => {
    const cache = await tmp("es-grammars-")
    let calls = 0
    const fetch = (async () => {
      calls++
      throw new Error("network down")
    }) as unknown as typeof globalThis.fetch
    const first = await extractStructure("a.py", "def f():\n  return 1\n", { cacheDir: cache, fetch })
    expect(first?.parser).toBe("regex")
    const second = await extractStructure("b.py", "def g():\n  return 2\n", { cacheDir: cache, fetch })
    expect(second?.parser).toBe("regex")
    expect(calls).toBe(1)
  })
})

// ---------------------------------------------------------------- extract

describe("regex extraction", () => {
  test("TypeScript imports and symbols", () => {
    const result = extractWithRegex(
      "typescript",
      [
        'import type { T } from "./types.js"',
        'import { b } from "../lib/util"',
        'import "./side"',
        'export { c } from "./c"',
        'const d = await import("./dyn")',
        'const e = require("./req")',
        "export function greet(): T { return b() }",
        "export class Box { open() {} }",
        "interface Shape {}",
        "type Alias = string",
        "export const VERSION = '1'",
      ].join("\n"),
    )
    expect(result.parser).toBe("regex")
    expect(result.imports.map((item) => [item.specifier, item.kind])).toEqual([
      ["./types.js", "type"],
      ["../lib/util", "static"],
      ["./side", "side-effect"],
      ["./c", "reexport"],
      ["./dyn", "dynamic"],
      ["./req", "require"],
    ])
    const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]))
    expect(byName.get("greet")).toMatchObject({ kind: "function", exported: true })
    expect(byName.get("Box")).toMatchObject({ kind: "class", exported: true })
    expect(byName.get("Shape")).toMatchObject({ kind: "interface", exported: false })
    expect(byName.get("Alias")).toMatchObject({ kind: "type", exported: false })
    expect(byName.get("VERSION")).toMatchObject({ kind: "constant", exported: true })
  })

  test("Python imports and definitions", () => {
    const result = extractWithRegex(
      "python",
      [
        "import os, sys as system",
        "from .core import helper as h, other",
        "async def run(x):",
        "    return x",
        "class User:",
        "    def greet(self): ...",
        "CONSTANT = 42",
        "_private = 1",
      ].join("\n"),
    )
    expect(result.imports.map((item) => item.specifier)).toEqual(["os", "sys", ".core"])
    expect(result.imports[2]?.names).toEqual(["helper", "other"])
    const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]))
    expect(byName.get("run")).toMatchObject({ kind: "function", exported: true })
    expect(byName.get("User")).toMatchObject({ kind: "class", exported: true })
    expect(byName.get("greet")).toMatchObject({ kind: "function", exported: true })
    expect(byName.get("CONSTANT")).toMatchObject({ kind: "constant", exported: true })
    expect(byName.get("_private")).toMatchObject({ kind: "variable", exported: false })
  })

  test("Go imports, functions, methods and package", () => {
    const result = extractWithRegex(
      "go",
      [
        "package pkg",
        "import (",
        '  "fmt"',
        '  x "example.com/m/util"',
        ")",
        'import "os"',
        "func Exported(a int) string { return fmt.Sprint(a) }",
        "func (r *Recv) method() {}",
        "const Max = 10",
      ].join("\n"),
    )
    expect(result.package).toBe("pkg")
    expect(result.imports.map((item) => item.specifier)).toEqual(["fmt", "example.com/m/util", "os"])
    const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]))
    expect(byName.get("Exported")).toMatchObject({ kind: "function", exported: true })
    expect(byName.get("Recv.method")).toMatchObject({ kind: "method", exported: false })
    expect(byName.get("Max")).toMatchObject({ kind: "constant", exported: true })
  })

  test("files without a grammar are not extracted", async () => {
    expect(await extractStructure("README.md", "# hi")).toBeUndefined()
  })
})

// ---------------------------------------------------------------- graph

const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

async function jsFixture(): Promise<string> {
  const root = await tmp("es-graph-")
  await write(root, "src/util.ts", "export const helper = () => 1\n")
  await write(root, "src/consumer.ts", 'import { helper } from "./util.js"\nexport const used = helper\n')
  await write(root, "src/consumer2.ts", 'import { used } from "./consumer"\nexport const later = used\n')
  await write(root, "src/util.test.ts", 'import { helper } from "./util"\n')
  await write(root, "src/consumer2.test.ts", 'import { later } from "./consumer2"\n')
  await write(
    root,
    "lib/package.json",
    JSON.stringify({ name: "@fx/lib", exports: { ".": "./src/index.ts", "./deep/*": "./src/*" } }),
  )
  await write(root, "lib/src/index.ts", "export const lib = 1\n")
  await write(root, "lib/src/deep.ts", "export const deep = 2\n")
  await write(root, "app.ts", 'import { lib } from "@fx/lib"\nexport const app = lib\n')
  await write(root, "app.test.ts", 'import { deep } from "@fx/lib/deep/deep"\nimport { lib } from "@fx/lib"\n')
  return root
}

describe("import graph and affected tests", () => {
  test("relative imports resolve through .js → .ts, index files and workspace exports", async () => {
    const root = await jsFixture()
    const graph = await buildImportGraph(root, { regexOnly: true })
    expect(graph).toBeDefined()
    const edges = (file: string) => [...(graph!.edges.get(file) ?? [])].sort()
    expect(edges("src/consumer.ts")).toEqual(["src/util.ts"])
    expect(edges("src/consumer2.ts")).toEqual(["src/consumer.ts"])
    expect(edges("app.ts")).toEqual(["lib/src/index.ts"])
    expect(edges("app.test.ts")).toEqual(["lib/src/deep.ts", "lib/src/index.ts"])
    expect(graph!.parsers.regex).toBeGreaterThan(0)
    expect(graph!.parsers.treeSitter).toBe(0)
  })

  test("affected tests are the reverse-reachable test files", async () => {
    const root = await jsFixture()
    const affected = await affectedTests(root, ["src/util.ts"], { regexOnly: true })
    expect(affected?.tests).toEqual(["src/consumer2.test.ts", "src/util.test.ts"])
    expect(affected?.known).toEqual(["src/util.ts"])
    // lib/src/deep.ts is imported by app.test.ts.
    expect((await affectedTests(root, ["lib/src/deep.ts"], { regexOnly: true }))?.tests).toEqual(["app.test.ts"])
    // Nothing imports a leaf document.
    expect((await affectedTests(root, ["README.md"], { regexOnly: true }))?.known).toBeUndefined()
  })

  test("python relative and absolute imports resolve to modules", async () => {
    const root = await tmp("es-graph-py-")
    await write(root, "pkg/__init__.py", "")
    await write(root, "pkg/core.py", "def thing():\n    return 1\n")
    await write(root, "pkg/user.py", "from .core import thing\n")
    await write(root, "pkg/tests/test_user.py", "from ..user import thing\n")
    await write(root, "svc/main.py", "from pkg.core import thing\n")
    await write(root, "svc/test_main.py", "from pkg.core import thing\n")
    const graph = await buildImportGraph(root, { regexOnly: true })
    const edges = (file: string) => [...(graph!.edges.get(file) ?? [])].sort()
    expect(edges("pkg/user.py")).toEqual(["pkg/core.py"])
    expect(edges("pkg/tests/test_user.py")).toEqual(["pkg/user.py"])
    expect(edges("svc/main.py")).toEqual(["pkg/core.py"])
    const affected = await affectedTests(root, ["pkg/core.py"], { regexOnly: true })
    expect(affected?.tests).toEqual(["pkg/tests/test_user.py", "svc/test_main.py"])
  })

  test("go imports resolve to a package directory; tests see their package", async () => {
    const root = await tmp("es-graph-go-")
    await write(root, "go/go.mod", "module example.com/m\n\ngo 1.22\n")
    await write(root, "go/pkg/a.go", "package pkg\n\nfunc A() int { return 1 }\n")
    await write(root, "go/pkg/a_test.go", 'package pkg\n\nimport "testing"\n\nfunc TestA(t *testing.T) { _ = A() }\n')
    await write(
      root,
      "go/other/b.go",
      'package other\n\nimport "example.com/m/pkg"\n\nfunc B() int { return pkg.A() }\n',
    )
    await write(
      root,
      "go/other/b_test.go",
      'package other\n\nimport "testing"\n\nfunc TestB(t *testing.T) { _ = B() }\n',
    )
    const graph = await buildImportGraph(root, { regexOnly: true })
    expect([...(graph!.edges.get("go/other/b.go") ?? [])].sort()).toEqual(["go/pkg/a.go"])
    const affected = await affectedTests(root, ["go/pkg/a.go"], { regexOnly: true })
    expect(affected?.tests).toEqual(["go/other/b_test.go", "go/pkg/a_test.go"])
    expect(dependentsOf(graph!, ["go/pkg/a.go"]).has("go/other/b_test.go")).toBe(true)
  })

  test("a project above the file cap yields no graph (callers fall back)", async () => {
    const root = await jsFixture()
    expect(await buildImportGraph(root, { regexOnly: true, maxFiles: 2 })).toBeUndefined()
    expect(await affectedTests(root, ["src/util.ts"], { regexOnly: true, maxFiles: 2 })).toBeUndefined()
  })
})

// ------------------------------------------------- tree-sitter integration
// Probes once at load: with a warm cache (or network) these run; otherwise
// they are skipped so the suite stays deterministic offline.

const available = async (id: GrammarId): Promise<boolean> => {
  try {
    await loadGrammar(id)
    return true
  } catch {
    return false
  }
}
const hasTypescript = await available("typescript")
const hasPython = await available("python")
const hasGo = await available("go")

describe("tree-sitter extraction", () => {
  test.skipIf(!hasTypescript)("TypeScript: imports, symbols and syntax errors", async () => {
    const structure = await extractStructure(
      "src/a.ts",
      [
        'import type { T } from "./types.js"',
        'import { b } from "../lib/util"',
        'const c = await import("./dyn")',
        "export function greet(name: string): T {",
        "  if (name && name.length > 1) return b(name)",
        "  return {} as T",
        "}",
        "export class Box { open() { return 1 } }",
        "export const VERSION = '1'",
      ].join("\n"),
    )
    expect(structure?.parser).toBe("tree-sitter")
    expect(structure?.syntaxErrors).toBeUndefined()
    expect(structure?.imports.map((item) => [item.specifier, item.kind])).toEqual([
      ["./types.js", "type"],
      ["../lib/util", "static"],
      ["./dyn", "dynamic"],
    ])
    expect(structure?.symbols.find((symbol) => symbol.name === "Box.open")?.kind).toBe("method")
    expect(structure?.symbols.find((symbol) => symbol.name === "greet")?.exported).toBe(true)
  })

  test.skipIf(!hasTypescript)("broken TypeScript still extracts with syntaxErrors set", async () => {
    const structure = await extractStructure("a.ts", "export function broken( {\n")
    expect(structure?.parser).toBe("tree-sitter")
    expect(structure?.syntaxErrors).toBe(true)
  })

  test.skipIf(!hasPython)("Python: relative imports carry names and methods attach to classes", async () => {
    const structure = await extractStructure(
      "pkg/user.py",
      [
        "from .core import helper as h, other",
        "class User:",
        "    def greet(self, x):",
        "        return h(x)",
        "CONSTANT = 42",
      ].join("\n"),
    )
    expect(structure?.parser).toBe("tree-sitter")
    expect(structure?.imports[0]).toMatchObject({ specifier: ".core", names: ["helper", "other"] })
    expect(structure?.symbols.map((symbol) => symbol.name)).toEqual(["User", "User.greet", "CONSTANT"])
  })

  test.skipIf(!hasGo)("Go: package, methods and exported detection", async () => {
    const structure = await extractStructure(
      "pkg/a.go",
      [
        "package pkg",
        'import "fmt"',
        "func Exported(a int) string { return fmt.Sprint(a) }",
        "func (r *Recv) method() {}",
      ].join("\n"),
    )
    expect(structure?.parser).toBe("tree-sitter")
    expect(structure?.package).toBe("pkg")
    expect(structure?.symbols.find((symbol) => symbol.name === "Exported")?.exported).toBe(true)
    expect(structure?.symbols.find((symbol) => symbol.name === "Recv.method")?.exported).toBe(false)
  })
})
