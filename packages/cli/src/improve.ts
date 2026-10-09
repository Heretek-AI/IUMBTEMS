// `es improve harvest` (#135): read-only telemetry harvest over run and eval
// dirs. Agent-safe by construction — it only reads the harvested roots and
// writes the one `--out` file — so it stays out of HUMAN_VERBS in core.
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { type Args, flag, harvestTelemetry } from "@heretek-ai/es-core"

const splitList = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)

export async function improveHarvest(args: Args, io: { print: (text: string) => void; cwd: string }): Promise<number> {
  const runs = splitList(flag(args, "runs")).map((dir) => path.resolve(io.cwd, dir))
  const evals = splitList(flag(args, "evals")).map((dir) => path.resolve(io.cwd, dir))
  if (runs.length === 0 && evals.length === 0) {
    io.print("Usage: es improve harvest --runs <dir>[,<dir>] [--evals <dir>[,<dir>]] --out <file>")
    return 2
  }
  const out = flag(args, "out")
  const telemetry = await harvestTelemetry({ runs, evals })
  const rendered = `${JSON.stringify(telemetry, null, 2)}\n`
  if (out) {
    const file = path.resolve(io.cwd, out)
    await writeFile(file, rendered)
    io.print(
      `Harvested ${telemetry.runs.length} run(s) and ${telemetry.evals.length} eval(s) to ${path.relative(io.cwd, file) || file} (telemetry v${telemetry.version}).`,
    )
    return 0
  }
  io.print(rendered.trimEnd())
  return 0
}
