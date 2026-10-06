import { stat } from "node:fs/promises"
import path from "node:path"
import { type GatesConfig, GatesConfigSchema } from "../schema/gates.ts"

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath)
    return s.isFile()
  } catch {
    return false
  }
}

export async function detectProjectGates(rootDir: string): Promise<GatesConfig> {
  const isBun =
    (await fileExists(path.join(rootDir, "bun.lock"))) || (await fileExists(path.join(rootDir, "bun.lockb")))

  const isCargo = await fileExists(path.join(rootDir, "Cargo.toml"))
  const isPython = await fileExists(path.join(rootDir, "pyproject.toml"))
  const _isNpm = await fileExists(path.join(rootDir, "package-lock.json"))
  const isPkgJson = await fileExists(path.join(rootDir, "package.json"))
  const isBiome =
    (await fileExists(path.join(rootDir, "biome.json"))) || (await fileExists(path.join(rootDir, "biome.jsonc")))

  if (isBun || (isPkgJson && !isCargo && !isPython)) {
    return GatesConfigSchema.parse({
      version: "1.0",
      commands: {
        format: isBiome
          ? { command: "biome format --write .", extensions: [".ts", ".tsx", ".js", ".json"] }
          : undefined,
        lint: isBiome ? { command: "biome check .", extensions: [".ts", ".tsx", ".js", ".json"] } : undefined,
        typecheck: { command: "tsc -b" },
        test: {
          command: isBun ? "bun test" : "npm test",
          fullCommand: isBun ? "bun test" : "npm test",
        },
      },
      budgets: {
        maxDiffLines: 500,
        maxFileLines: 800,
        requireDepJustification: true,
      },
      security: {
        secrets: true,
        osv: false,
      },
    })
  }

  if (isCargo) {
    return GatesConfigSchema.parse({
      version: "1.0",
      commands: {
        format: { command: "cargo fmt --check", extensions: [".rs"] },
        lint: { command: "cargo clippy -- -D warnings", extensions: [".rs"] },
        test: { command: "cargo test", fullCommand: "cargo test" },
      },
      budgets: {
        maxDiffLines: 600,
        maxFileLines: 1000,
        requireDepJustification: true,
      },
      security: {
        secrets: true,
        osv: false,
      },
    })
  }

  if (isPython) {
    return GatesConfigSchema.parse({
      version: "1.0",
      commands: {
        format: { command: "ruff format --check .", extensions: [".py"] },
        lint: { command: "ruff check .", extensions: [".py"] },
        typecheck: { command: "mypy ." },
        test: { command: "pytest", fullCommand: "pytest" },
      },
      budgets: {
        maxDiffLines: 500,
        maxFileLines: 800,
        requireDepJustification: true,
      },
      security: {
        secrets: true,
        osv: false,
      },
    })
  }

  return GatesConfigSchema.parse({
    version: "1.0",
    commands: {},
    budgets: {
      maxDiffLines: 500,
      maxFileLines: 800,
      requireDepJustification: true,
    },
    security: {
      secrets: true,
      osv: false,
    },
  })
}
