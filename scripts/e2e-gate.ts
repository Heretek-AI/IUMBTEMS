// Regression gate for the E2E feedback workflow (#68, option 1: report,
// gate on regressions only). Compares the current evals/results JSON against
// the per-case history in the last runs of the same workflow: a case is
// historically stable when it passed at least 90% of 5+ sampled runs, and
// the job fails only when a stable case fails now. Every run still uploads
// its artifact and per-case table; this step only decides the verdict.
//
// History comes from the `e2e-feedback` artifacts of recent completed runs
// on the same branch, via `gh` (GH_TOKEN in CI, `actions: read`). When no
// history can be read at all, it falls back to failing on any current
// failure, so a broken history fetch can neither hide a regression nor
// silently green a red run.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

interface EvalRow {
  id: string
  pass: boolean
}

interface EvalFile {
  results?: EvalRow[]
}

const resultsPath = process.argv[2]
if (!resultsPath) {
  console.error("usage: bun scripts/e2e-gate.ts <evals-results-json>")
  process.exit(2)
}

const raw = await readFile(path.isAbsolute(resultsPath) ? resultsPath : path.join(root, resultsPath), "utf8").catch(
  () => undefined,
)
if (raw === undefined) {
  console.error(`e2e-gate: cannot read ${resultsPath}`)
  process.exit(2)
}
const rows = (JSON.parse(raw) as EvalFile).results ?? []
const failed = rows.filter((row) => !row.pass).map((row) => row.id)
if (!failed.length) {
  console.log(`e2e-gate: ${rows.length}/${rows.length} passed, nothing to gate.`)
  process.exit(0)
}

const ghOut = (args: string[]) => {
  try {
    const proc = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" })
    if (proc.exitCode !== 0) return undefined
    return new TextDecoder().decode(proc.stdout).trim() || undefined
  } catch {
    return undefined
  }
}

/** `gh` commands that signal only by exit code (`run download` prints nothing on success). */
const ghOk = (args: string[]) => {
  try {
    return Bun.spawnSync(["gh", ...args], { stdout: "ignore", stderr: "pipe" }).exitCode === 0
  } catch {
    return false
  }
}

const branch = process.env.GITHUB_REF_NAME ?? "rewrite"
const repo = process.env.GITHUB_REPOSITORY
const repoArgs = repo ? ["--repo", repo] : []
const listed = ghOut([
  "run",
  "list",
  "--workflow",
  "e2e-feedback.yml",
  "--branch",
  branch,
  "--status",
  "completed",
  "--limit",
  "15",
  "--json",
  "databaseId,conclusion",
  ...repoArgs,
])
const runs = listed ? (JSON.parse(listed) as Array<{ databaseId: number; conclusion: string }>) : undefined
if (!runs) {
  console.log(`e2e-gate: cannot read workflow history; failing on ${failed.length} current failure(s): ${failed.join(", ")}`)
  process.exit(1)
}

const scratch = await mkdtemp(path.join(tmpdir(), "e2e-gate-"))
try {
  const tally = new Map<string, { samples: number; passes: number }>()
  let sampled = 0
  for (const run of runs) {
    if (run.conclusion !== "success" && run.conclusion !== "failure") continue
    if (sampled >= 10) break
    const dir = path.join(scratch, String(run.databaseId))
    if (!ghOk(["run", "download", String(run.databaseId), "--name", "e2e-feedback", "--dir", dir, ...repoArgs])) continue
    const files: string[] = []
    const walk = async (d: string) => {
      for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith(".json")) files.push(full)
      }
    }
    await walk(dir)
    let found = false
    for (const file of files) {
      try {
        const data = JSON.parse(await readFile(file, "utf8")) as EvalFile
        if (!Array.isArray(data.results)) continue
        for (const row of data.results) {
          const cell = tally.get(row.id) ?? { samples: 0, passes: 0 }
          cell.samples += 1
          if (row.pass) cell.passes += 1
          tally.set(row.id, cell)
        }
        found = true
        break
      } catch {
        // not a results file; keep looking
      }
    }
    if (found) sampled += 1
  }
  const stable = [...tally]
    .filter(([, cell]) => cell.samples >= 5 && cell.passes / cell.samples >= 0.9)
    .map(([id]) => id)
  console.log(`e2e-gate: sampled ${sampled} prior run(s); stable cases: ${stable.length ? stable.join(", ") : "(none yet)"}`)
  const regressions = failed.filter((id) => stable.includes(id))
  if (!regressions.length) {
    console.log(`e2e-gate: ${failed.length} current failure(s) (${failed.join(", ")}) are not regressions of stable cases; passing.`)
    process.exit(0)
  }
  console.log(`e2e-gate: REGRESSION in historically stable case(s): ${regressions.join(", ")}`)
  process.exit(1)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
