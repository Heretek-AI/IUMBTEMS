// Regression gate for the E2E feedback workflow (#68, option 1: report,
// gate on regressions only). Compares the current evals/results JSON against
// the per-case history in the last runs of the same workflow: a case is
// historically stable when it passed at least 90% of 5+ sampled runs, and
// the job fails only when a stable case fails now. Every run still uploads
// its artifact and per-case table; this step only decides the verdict.
//
// Sticky red (#323): the stable set above is computed over the sampled
// window, so two red runs can pull a case under the 90% line and its third
// failure would pass. A case that was stable before its current
// consecutive-failure streak keeps failing the gate until it passes again
// or a human acknowledges that streak in evals/acknowledgments.json
// (`{version: 1, acknowledgments: [{case, reason, issue, date}]}` — case id,
// reason, issue link, date; humans only, see the write policy). The
// acknowledgment is bound to its streak by date: a pass sampled after its
// date ends the streak, and a later failure is a new regression.
// Fail-closed: an unreadable or malformed acknowledgment file fails the
// gate, and unknown (never-sampled) IDs are regressions an acknowledgment
// never excuses (#210: zero sampled history with failures exits 2).
// Exits: 0 green (no failures, or failures confined to known-unstable or
// acknowledged cases), 1 regression (or unreadable/malformed
// acknowledgments), 2 red run with no history to judge it against.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  decideGateVerdict,
  parseAcknowledgments,
  type GateAcknowledgment,
  type GateHistoryRun,
} from "../packages/core/src/evals/gate.ts"

const root = path.resolve(import.meta.dir, "..")
const resultsDir = path.join(root, "evals", "results")

interface EvalRow {
  id: string
  pass: boolean
}

interface EvalFile {
  results?: EvalRow[]
}

/** The newest flat results JSON. No path argument: the gate reads what the
 * eval run just wrote, so no caller-supplied path can reach the filesystem.
 */
async function newestResults(): Promise<string | undefined> {
  const flat = (await readdir(resultsDir).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".json"))
    .sort()
  const latest = flat.at(-1)
  return latest ? path.join(resultsDir, latest) : undefined
}

const resultsPath = await newestResults()
if (!resultsPath) {
  console.error("e2e-gate: no evals/results/*.json (the eval run never wrote one)")
  process.exit(2)
}

const raw = await readFile(resultsPath, "utf8").catch(() => undefined)
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

// Human-only acknowledgments (#323): fail closed on an unreadable or
// malformed file rather than greening past a red run without them.
const ackPath = path.join(root, "evals", "acknowledgments.json")
const ackRaw = await readFile(ackPath, "utf8").catch(() => undefined)
if (ackRaw === undefined) {
  console.error(`e2e-gate: cannot read ${ackPath}; refusing to green a red run without its acknowledgments.`)
  process.exit(1)
}
const parsedAcks = parseAcknowledgments(ackRaw)
if ("error" in parsedAcks) {
  console.error(`e2e-gate: ${ackPath}: ${parsedAcks.error} Refusing to green a red run on a malformed file.`)
  process.exit(1)
}
const acks: GateAcknowledgment[] = parsedAcks.acks

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

const branch = process.env.GITHUB_REF_NAME ?? "main"
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
  "databaseId,conclusion,createdAt",
  ...repoArgs,
])
const runs = listed
  ? (JSON.parse(listed) as Array<{ databaseId: number; conclusion: string; createdAt?: string }>)
  : undefined
if (!runs) {
  console.log(`e2e-gate: cannot read workflow history; failing on ${failed.length} current failure(s): ${failed.join(", ")}`)
  process.exit(1)
}

const scratch = await mkdtemp(path.join(tmpdir(), "e2e-gate-"))
try {
  const tally = new Map<string, { samples: number; passes: number }>()
  // Ordered history (newest first) for the sticky-red rule (#323): `gh run
  // list` is newest first, but sort explicitly on the monotonic run id.
  const history: GateHistoryRun[] = []
  let sampled = 0
  for (const run of [...runs].sort((a, b) => b.databaseId - a.databaseId)) {
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
        const passes: Record<string, boolean> = {}
        for (const row of data.results) {
          const cell = tally.get(row.id) ?? { samples: 0, passes: 0 }
          cell.samples += 1
          if (row.pass) cell.passes += 1
          tally.set(row.id, cell)
          passes[row.id] = row.pass
        }
        // A missing createdAt keeps the run's position (id order) but its
        // timestamp sorts as newer than any acknowledgment (fail closed).
        history.push({ id: String(run.databaseId), at: run.createdAt ?? "", passes })
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
  // Fail-closed (#210): zero sampled history with failures exits 2 (not
  // green), and failed IDs never seen in history count as regressions.
  const verdict = decideGateVerdict({ failed, stable, sampled, known: [...tally.keys()], history, acks })
  console.log(`e2e-gate: ${verdict.message}`)
  process.exit(verdict.exit)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
