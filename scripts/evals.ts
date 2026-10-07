// Opt-in, cost-capped behaviour evals. Never part of `bun test`; run by
// `bun run evals`, the E2E feedback workflow or the nightly job. Needs the
// opencode CLI and ES_EVAL_MODEL ("provider/model"; the provider's API key in
// its usual env var) and skips cleanly without them. Each case runs one real
// turn in an isolated workspace loading this repo's plugin, killed at:
// - its own step cap (`maxSteps`, sized for a model that makes one call per
//   step), bounded by the ceiling ES_EVAL_MAX_STEPS (default 16);
// - the timeout (ES_EVAL_TIMEOUT_MS, default 300000);
// - the run's spend budget ES_EVAL_MAX_USD (optional; summed from the stream's
//   step_finish cost). Once it is spent, the remaining cases are not run.
// A failed case keeps its workspace, event stream and stderr under
// evals/results/<stamp>/<case>/ for debugging.
import { accessSync, constants } from "node:fs"
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { gradeFireCase } from "../packages/core/src/evals/fires.ts"
import { caseStepCap, type EvalCase, evalWorkspace, runEvalCase } from "../packages/core/src/evals/run.ts"
import { renderEvalPrompt, startServeFixtures } from "../packages/core/src/evals/serve.ts"

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
const stepCeiling = Number(process.env.ES_EVAL_MAX_STEPS || 16)
const timeoutMs = Number(process.env.ES_EVAL_TIMEOUT_MS || 300_000)
const budgetUSD = process.env.ES_EVAL_MAX_USD ? Number(process.env.ES_EVAL_MAX_USD) : undefined
if (!Number.isInteger(stepCeiling) || stepCeiling <= 0) {
  console.error(`evals: ES_EVAL_MAX_STEPS must be a positive integer (got ${process.env.ES_EVAL_MAX_STEPS}).`)
  process.exit(2)
}
if (budgetUSD !== undefined && !(Number.isFinite(budgetUSD) && budgetUSD > 0)) {
  console.error(`evals: ES_EVAL_MAX_USD must be a positive number (got ${process.env.ES_EVAL_MAX_USD}).`)
  process.exit(2)
}

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

const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const files = (await readdir(casesDir)).filter((file) => file.endsWith(".json")).sort()
// Fixture pages for fetch cases ({{SERVE_URL}} in prompts); localhost only.
const serve = await startServeFixtures(path.join(root, "evals/serve"))
const results = []
let spentUSD = 0
for (const file of files) {
  const raw = JSON.parse(await readFile(path.join(casesDir, file), "utf8")) as EvalCase
  const testCase = { ...raw, prompt: renderEvalPrompt(raw.prompt, serve.url) }
  const maxSteps = caseStepCap(testCase.maxSteps, stepCeiling)
  const remaining = budgetUSD === undefined ? undefined : budgetUSD - spentUSD
  if (remaining !== undefined && remaining <= 0) {
    const failure = `not run: spend budget $${budgetUSD} used up`
    results.push({ id: testCase.id, agent: testCase.agent, description: testCase.description, pass: false, maxSteps, failures: [failure] })
    console.log(`SKIP ${testCase.id} — ${failure}`)
    continue
  }
  const workspace = await evalWorkspace({
    pluginDir: path.join(root, "packages/opencode"),
    model,
    files: await seedFiles(testCase.files as Record<string, string> | undefined),
  })
  try {
    const ran = await runEvalCase(testCase, workspace, { binary, maxSteps, timeoutMs, budgetUSD: remaining })
    spentUSD += ran.transcript.costUSD
    // A fire is scored by the same deterministic grader the CI suites use.
    const fire = testCase.fire ? await gradeFireCase(testCase.fire, workspace.dir) : undefined
    const result = fire
      ? { ...ran, pass: ran.pass && fire.pass, failures: [...ran.failures, ...fire.failures] }
      : ran
    // Keep a failed case's evidence: its project (with .factory/), events and stderr.
    let kept: string | undefined
    if (!result.pass) {
      const keep = path.join(resultsDir, stamp, testCase.id)
      await mkdir(keep, { recursive: true })
      await cp(workspace.dir, path.join(keep, "project"), { recursive: true, verbatimSymlinks: true })
      await writeFile(path.join(keep, "events.jsonl"), result.events.map((event) => JSON.stringify(event)).join("\n"))
      await writeFile(path.join(keep, "stderr.txt"), result.stderr)
      kept = path.relative(root, keep)
    }
    results.push({
      id: result.id,
      agent: testCase.agent,
      description: testCase.description,
      pass: result.pass,
      maxSteps,
      exitCode: result.exitCode,
      capped: result.capped,
      timedOut: result.timedOut,
      overBudget: result.overBudget,
      steps: result.transcript.steps,
      tools: result.transcript.tools,
      completed: result.transcript.completed,
      costUSD: result.transcript.costUSD,
      tokens: result.transcript.tokens,
      errors: result.transcript.errors,
      // The full text can be large; the debug report carries an excerpt.
      textExcerpt: result.transcript.text.slice(0, 2000),
      failures: result.failures,
      ...(kept ? { kept } : {}),
    })
    console.log(
      `${result.pass ? "PASS" : "FAIL"} ${result.id} (${result.transcript.steps}/${maxSteps} step(s), $${result.transcript.costUSD.toFixed(4)})${result.pass ? "" : ` — ${result.failures.join("; ")}`}`,
    )
  } finally {
    await workspace.cleanup()
  }
}

await mkdir(resultsDir, { recursive: true })
serve.stop()
await writeFile(
  path.join(resultsDir, `${stamp}.json`),
  `${JSON.stringify({ at: stamp, model, stepCeiling, budgetUSD, spentUSD, results }, null, 2)}\n`,
)
console.log(`evals: spent $${spentUSD.toFixed(4)}${budgetUSD === undefined ? "" : ` of $${budgetUSD}`}.`)
if (results.some((result) => !result.pass)) process.exit(1)
