// Opt-in, cost-capped behaviour evals. Never part of `bun test`; run by
// `bun run evals`, the E2E feedback workflow or the nightly job. Needs the
// opencode CLI and ES_EVAL_MODEL ("provider/model"; the provider's API key in
// its usual env var) and skips cleanly without them. Each case runs one real
// turn in an isolated workspace loading this repo's plugin, killed at:
// - its own step cap (`maxSteps`, sized for a model that makes one call per
//   step), bounded by the ceiling ES_EVAL_MAX_STEPS (default 24);
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
import { exists } from "../packages/core/src/util/fs.ts"
import { sealHumanKey, unlockHumanKey } from "../packages/core/src/approval/keystore.ts"
import { detectGates } from "../packages/core/src/gates/detect.ts"
import { commandSetHash, trustProject } from "../packages/core/src/trust/store.ts"
import { engineSignedFiles, signEngineFile } from "../packages/core/src/trust/sidecar.ts"

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
const stepCeiling = Number(process.env.ES_EVAL_MAX_STEPS || 24)
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
    results.push({ id: testCase.id, agent: testCase.agent, description: testCase.description, pass: false, maxSteps, failures: [failure], ...(testCase.modelLimited ? { modelLimited: testCase.modelLimited } : {}) })
    console.log(`SKIP ${testCase.id} — ${failure}`)
    continue
  }
  const workspace = await evalWorkspace({
    pluginDir: path.join(root, "packages/opencode"),
    model,
    files: await seedFiles(testCase.files as Record<string, string> | undefined),
  })
  // Seeded engine-owned files (reviewed fixtures, e.g. the audit-fires run)
  // are adopted the way `es reseal --sign` adopts them: signed under this
  // workspace's engine key before the model runs, so the seal check cannot
  // tell reviewed fixtures from forged ones — review them like code.
  for (const file of engineSignedFiles(workspace.dir)) {
    const seeded = (testCase.files as Record<string, string> | undefined)?.[path.relative(workspace.dir, file)]
    if (seeded !== undefined) await signEngineFile(file, workspace.stateDir)
  }
  // Seeded phase worktrees (reviewed fixtures, e.g. the programmer BUILD
  // run) need two things a bare seed lacks, or no model can pass:
  // committed files, so full-scope gates see them via `git ls-files`, and a
  // trusted gate command set, or every es_gates_run fails trust/untrusted.
  // Both are adopted the way `es reseal --sign` and `es trust` adopt
  // reviewed content: fixtures are reviewed like code, and the ephemeral
  // human key lives in this workspace's state dir only.
  const worktreeDirs = [
    ...new Set(
      Object.keys((testCase.files as Record<string, string> | undefined) ?? {})
        .filter((file) => file.startsWith(".factory/worktrees/") && file.endsWith("/package.json"))
        .map((file) => path.join(workspace.dir, path.dirname(file))),
    ),
  ]
  if (worktreeDirs.length) {
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: workspace.dir, stdout: "ignore", stderr: "ignore" }).exitCode === 0
    if (git(["rev-parse", "--is-inside-work-tree"])) {
      git(["add", "-A"])
      git(["-c", "user.name=es-eval", "-c", "user.email=es-eval@local", "commit", "-qm", "seed eval fixture"])
    }
    await sealHumanKey("es-eval-fixture", workspace.stateDir)
    const signer = await unlockHumanKey("es-eval-fixture", workspace.stateDir)
    for (const dir of worktreeDirs) {
      const detected = await detectGates(dir)
      if (!detected.commands.length) continue
      const { hash, lines } = await commandSetHash(dir, detected.commands)
      await trustProject(workspace.dir, hash, lines, { stateDir: workspace.stateDir, signer })
    }
  }
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
      // The artifact upload drops dot-directories, so mirror .factory/ under
      // a visible name too; without it the kept project has no run state,
      // worktree or gate logs to debug from.
      const dotFactory = path.join(workspace.dir, ".factory")
      if (await exists(dotFactory)) await cp(dotFactory, path.join(keep, "factory"), { recursive: true })
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
      ...(testCase.modelLimited ? { modelLimited: testCase.modelLimited } : {}),
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
