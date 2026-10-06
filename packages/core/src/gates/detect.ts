// Infer gate commands from project manifests. Every command checks; none
// rewrites files. Multiple ecosystems in one repo each contribute checks.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { type CommandCheck, CommandCheckSchema, type GatesConfig, GatesConfigSchema } from "../schema/gates.ts"
import { exists } from "../util/fs.ts"
import { parseJsonc } from "../util/jsonc.ts"

const JS_EXT = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".jsonc"]
const JS_CODE_EXT = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]

const check = (input: Partial<CommandCheck> & Pick<CommandCheck, "id" | "kind" | "command">) =>
  CommandCheckSchema.parse(input)

async function readText(file: string) {
  return readFile(file, "utf8").catch(() => undefined)
}

async function jsChecks(dir: string): Promise<CommandCheck[]> {
  const pkgText = await readText(path.join(dir, "package.json"))
  if (pkgText === undefined) return []
  let pkg: {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  try {
    pkg = JSON.parse(pkgText)
  } catch {
    return []
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const has = (name: string) => name in deps
  const scripts = pkg.scripts ?? {}
  const bun = (await exists(path.join(dir, "bun.lock"))) || (await exists(path.join(dir, "bun.lockb")))
  const runScript = (name: string) => (bun ? `bun run ${name}` : `npm run --silent ${name}`)
  const biome =
    has("@biomejs/biome") ||
    (await exists(path.join(dir, "biome.json"))) ||
    (await exists(path.join(dir, "biome.jsonc")))
  const out: CommandCheck[] = []

  if (biome) {
    out.push(
      check({
        id: "format",
        kind: "format",
        command: "biome format --reporter=json",
        parser: "biome",
        touchedArgs: true,
        extensions: JS_EXT,
      }),
    )
    out.push(
      check({
        id: "lint",
        kind: "lint",
        command: "biome lint --reporter=json",
        parser: "biome",
        touchedArgs: true,
        extensions: JS_EXT,
      }),
    )
  } else {
    if (has("prettier"))
      out.push(
        check({
          id: "format",
          kind: "format",
          command: "prettier --check",
          parser: "prettier",
          touchedArgs: true,
          extensions: JS_EXT,
        }),
      )
    if (has("eslint"))
      out.push(
        check({
          id: "lint",
          kind: "lint",
          command: "eslint -f json",
          parser: "eslint",
          touchedArgs: true,
          extensions: JS_CODE_EXT,
        }),
      )
  }

  const tsconfig = path.join(dir, "tsconfig.json")
  if (await exists(tsconfig)) {
    if (scripts.typecheck)
      out.push(check({ id: "typecheck", kind: "typecheck", command: runScript("typecheck"), parser: "tsc" }))
    else {
      const config = parseJsonc<{ references?: unknown[] }>((await readText(tsconfig)) ?? "{}")
      const command = config.references?.length ? "tsc -b --noEmit" : "tsc --noEmit -p tsconfig.json"
      out.push(check({ id: "typecheck", kind: "typecheck", command, parser: "tsc" }))
    }
  }

  if (has("vitest"))
    out.push(check({ id: "test", kind: "test", command: "vitest run", parser: "vitest", related: "vitest" }))
  else if (has("jest")) out.push(check({ id: "test", kind: "test", command: "jest", parser: "jest", related: "jest" }))
  else if (bun || has("@types/bun") || has("bun-types"))
    out.push(check({ id: "test", kind: "test", command: "bun test", parser: "bun-test", related: "bun" }))
  else if (scripts.test && !/no test specified/.test(scripts.test))
    out.push(
      check({ id: "test", kind: "test", command: bun ? "bun run test" : "npm test --silent", parser: "generic" }),
    )
  return out
}

async function pythonChecks(dir: string): Promise<CommandCheck[]> {
  const pyproject = await readText(path.join(dir, "pyproject.toml"))
  const isPython =
    pyproject !== undefined ||
    (await exists(path.join(dir, "requirements.txt"))) ||
    (await exists(path.join(dir, "setup.py")))
  if (!isPython) return []
  const text = pyproject ?? ""
  const out: CommandCheck[] = []
  const ruff = /\[tool\.ruff/.test(text) || /\bruff\b/.test(text) || (await exists(path.join(dir, "ruff.toml")))
  if (ruff) {
    out.push(
      check({
        id: "py-format",
        kind: "format",
        command: "ruff format --check",
        parser: "ruff-format",
        touchedArgs: true,
        extensions: [".py"],
      }),
    )
    out.push(
      check({
        id: "py-lint",
        kind: "lint",
        command: "ruff check --output-format=json",
        parser: "ruff",
        touchedArgs: true,
        extensions: [".py"],
      }),
    )
  }
  if (/\[tool\.mypy/.test(text) || (await exists(path.join(dir, "mypy.ini"))))
    out.push(check({ id: "py-typecheck", kind: "typecheck", command: "mypy .", parser: "mypy" }))
  out.push(check({ id: "py-test", kind: "test", command: "python3 -m pytest -q", parser: "pytest", related: "pytest" }))
  return out
}

async function rustChecks(dir: string): Promise<CommandCheck[]> {
  if (!(await exists(path.join(dir, "Cargo.toml")))) return []
  return [
    check({ id: "rs-format", kind: "format", command: "cargo fmt --check", parser: "generic" }),
    check({
      id: "rs-lint",
      kind: "lint",
      command: "cargo clippy --message-format=json -- -D warnings",
      parser: "cargo",
    }),
    check({ id: "rs-test", kind: "test", command: "cargo test", parser: "cargo-test" }),
  ]
}

async function goChecks(dir: string): Promise<CommandCheck[]> {
  if (!(await exists(path.join(dir, "go.mod")))) return []
  return [
    check({ id: "go-format", kind: "format", command: "gofmt -l .", parser: "gofmt" }),
    check({ id: "go-lint", kind: "lint", command: "go vet ./...", parser: "go-vet" }),
    check({ id: "go-test", kind: "test", command: "go test ./...", parser: "go-test", related: "go" }),
  ]
}

export async function detectGates(dir: string): Promise<GatesConfig> {
  const commands = [
    ...(await jsChecks(dir)),
    ...(await pythonChecks(dir)),
    ...(await rustChecks(dir)),
    ...(await goChecks(dir)),
  ]
  const seen = new Set<string>()
  const unique = commands.map((item) => {
    let id = item.id
    for (let n = 2; seen.has(id); n++) id = `${item.id}-${n}`
    seen.add(id)
    return { ...item, id }
  })
  return GatesConfigSchema.parse({ commands: unique })
}
