// Opt-in, cost-capped behaviour evals (grill / brainstorm / factory). Never
// part of `bun test`; run by `bun run evals` or the nightly job. Needs the
// opencode CLI and ES_EVAL_MODEL ("provider/model"; the provider's API key in
// its usual env var) and skips cleanly without them. Each case runs one real
// turn in an isolated workspace loading this repo's plugin, killed at the
// step cap (ES_EVAL_MAX_STEPS, default 6; a case may set a lower maxSteps) or
// the timeout (ES_EVAL_TIMEOUT_MS, default 300000).
import { accessSync, constants } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { gradeFireCase } from "../packages/core/src/evals/fires.ts"
import { type EvalCase, evalWorkspace, runEvalCase } from "../packages/core/src/evals/run.ts"

const root = path.resolve(import.meta.dir, "..")
const casesDir = path.join(root, "evals/cases")
const fixturesDir = path.join(root, "packages/core/test/fixtures")

/** Seed values may be "@fixture:<path>" (relative to packages/core/test/fixtures) to keep cases small. */
async function seedFiles(files: Record<string, string> | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [file, value] of Object.entries(files ?? {}))
    out[file] = value.startsWith("@fixture:") ? await readFile(path.join(fixturesDir, value.slice(9)), "utf8") : value
  return out
}
const resultsDir = path.join(root, "evals/results")
const model = process.env.ES_EVAL_MODEL
const maxSteps = Number(process.env.ES_EVAL_MAX_STEPS ?? 6)
const timeoutMs = Number(process.env.ES_EVAL_TIMEOUT_MS ?? 300_000)

function resolveOnPath(binary: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    try {
      accessSync(path.join(dir, binary), constants.X_OK)
      return path.join(dir, binary)
    } catch {
      // not executable here; keep looking
    }
  }
  return undefined
}

const binary = resolveOnPath("opencode")
if (!binary || !model) {
  console.log(`evals: skipping (${binary ? "" : "no opencode CLI on PATH; "}${model ? "" : "ES_EVAL_MODEL is not set"}).`)
  process.exit(0)
}

const files = (await readdir(casesDir)).filter((file) => file.endsWith(".json")).sort()
const results = []
for (const file of files) {
  const testCase = JSON.parse(await readFile(path.join(casesDir, file), "utf8")) as EvalCase & { maxSteps?: number }
  const workspace = await evalWorkspace({
    pluginDir: path.join(root, "packages/opencode"),
    model,
    files: await seedFiles(testCase.files as Record<string, string> | undefined),
  })
  try {
    const ran = await runEvalCase(testCase, workspace, {
      binary,
      maxSteps: Math.min(testCase.maxSteps ?? maxSteps, maxSteps),
      timeoutMs,
    })
    // A fire is scored by the same deterministic grader the CI suites use.
    const fire = testCase.fire ? await gradeFireCase(testCase.fire, workspace.dir) : undefined
    const result = fire
      ? { ...ran, pass: ran.pass && fire.pass, failures: [...ran.failures, ...fire.failures] }
      : ran
    results.push({
      id: result.id,
      pass: result.pass,
      steps: result.transcript.steps,
      tools: result.transcript.tools,
      failures: result.failures,
    })
    console.log(
      `${result.pass ? "PASS" : "FAIL"} ${result.id} (${result.transcript.steps} step(s))${result.pass ? "" : ` — ${result.failures.join("; ")}`}`,
    )
  } finally {
    await workspace.cleanup()
  }
}

await mkdir(resultsDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
await writeFile(
  path.join(resultsDir, `${stamp}.json`),
  `${JSON.stringify({ at: stamp, model, maxSteps, results }, null, 2)}\n`,
)
if (results.some((result) => !result.pass)) process.exit(1)
