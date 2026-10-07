// Opt-in, cost-capped behaviour evals (grill / brainstorm / factory). Never part
// of `bun test`; run by `bun run evals` or the nightly job. It skips cleanly
// when the `opencode` CLI (and therefore a provider) is unavailable, so the
// scheduled job is harmless without credentials, and each case is bounded by
// ES_EVAL_TIMEOUT_MS.
import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { gradeOutput } from "../packages/core/src/evals/grade.ts"

const root = path.resolve(import.meta.dir, "..")
const casesDir = path.join(root, "evals/cases")
const resultsDir = path.join(root, "evals/results")
const timeoutMs = Number(process.env.ES_EVAL_TIMEOUT_MS ?? 300_000)

interface EvalCase {
  readonly id: string
  readonly description: string
  readonly agent: string
  readonly prompt: string
  readonly checks?: { readonly contains?: string[]; readonly notContains?: string[] }
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

function runCase(binary: string, testCase: EvalCase): Promise<{ output: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["run", "--standalone", "--format", "json", "--agent", testCase.agent, testCase.prompt], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      output += String(chunk)
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ output, code })
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ output, code: null })
    })
  })
}

const binary = resolveOnPath("opencode")
if (!binary) {
  console.log("evals: the `opencode` CLI is not on PATH; skipping (expected without a provider).")
  process.exit(0)
}

const files = (await readdir(casesDir)).filter((file) => file.endsWith(".json")).sort()
const results: Array<{ id: string; pass: boolean; exitCode: number | null; failures: readonly string[] }> = []
for (const file of files) {
  const testCase = JSON.parse(await readFile(path.join(casesDir, file), "utf8")) as EvalCase
  const { output, code } = await runCase(binary, testCase)
  const grade = gradeOutput(output, testCase.checks)
  const pass = code === 0 && grade.pass
  results.push({ id: testCase.id, pass, exitCode: code, failures: grade.failures })
  console.log(`${pass ? "PASS" : "FAIL"} ${testCase.id}${pass ? "" : ` — ${grade.failures.join("; ") || `exit ${code}`}`}`)
}

await mkdir(resultsDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
await writeFile(path.join(resultsDir, `${stamp}.json`), `${JSON.stringify({ at: stamp, results }, null, 2)}\n`)
if (results.some((result) => !result.pass)) process.exit(1)
