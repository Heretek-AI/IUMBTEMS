// `es improve` (#135 harvest, #136 distill): read-only telemetry harvest
// over run and eval dirs, and deterministic distillation into reviewable
// proposals. Both verbs are agent-safe by construction — they only read the
// inputs and write the one `--out` location — so they stay out of HUMAN_VERBS
// in core. Only `--open-pr` publishes, and it is human-run: without a
// terminal it refuses instead of opening anything.
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  type Args,
  compareStrings,
  type DistillThresholds,
  disposedWithReasons,
  distillProposals,
  factoryLayout,
  flag,
  git,
  harvestTelemetry,
  type Proposal,
  renderProposalFiles,
  run,
  type Telemetry,
  TelemetrySchema,
  undisposed,
  type WrittenProposal,
  writeDropped,
  writeProposals,
} from "@heretek-ai/es-core"
import type { ConfirmIO } from "./tty.ts"
import { NotInteractive } from "./tty.ts"

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
    const rel = path.relative(io.cwd, file) || file
    io.print(
      `Harvested ${telemetry.runs.length} run(s) and ${telemetry.evals.length} eval(s) to ${rel} (telemetry v${telemetry.version}).`,
    )
    return 0
  }
  io.print(rendered.trimEnd())
  return 0
}

export interface ImproveIO {
  readonly print: (text: string) => void
  readonly cwd: string
  readonly confirm: ConfirmIO
}

/** Stage only the proposal dirs, commit on a topic branch and open a draft PR. Never pushes the base branch. */
export async function openProposalsPr(
  root: string,
  proposalDirs: readonly string[],
  options: {
    readonly base?: string
    readonly date?: string
    readonly run?: (argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  } = {},
): Promise<{ branch: string; url: string; staged: string[] }> {
  const exec = options.run ?? ((argv: readonly string[]) => run([...argv], { cwd: root, timeoutMs: 60_000 }))
  const auth = await exec(["gh", "auth", "status"])
  if (auth.code !== 0) throw new Error("gh is not authenticated (gh auth status failed); cannot open a draft PR.")
  const stamp = (options.date ?? new Date().toISOString().slice(0, 10)).replaceAll("-", "")
  const branch = `improve/${stamp}`
  const current = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
  const base = options.base ?? current.stdout.trim()
  if (!base) throw new Error("cannot determine the PR base branch")
  await git(root, ["checkout", "-b", branch])
  const staged = [...proposalDirs]
  staged.sort(compareStrings)
  await git(root, ["add", "--", ...staged])
  await git(root, ["commit", "-q", "-m", `Distilled improvement proposals (${staged.length})`])
  await git(root, ["push", "--set-upstream", "origin", `${branch}:${branch}`])
  const pr = await exec([
    "gh",
    "pr",
    "create",
    "--draft",
    "--head",
    branch,
    "--base",
    base,
    "--title",
    `Distilled improvement proposals (${stamp})`,
    "--body",
    prBody(root, staged),
  ])
  const url = prUrl(pr.stdout)
  if (pr.code !== 0 || !url) throw new Error("gh pr create failed")
  return { branch, url, staged }
}

const prBody = (root: string, staged: readonly string[]): string => {
  const entries = staged.map((dir) => `- ${path.relative(root, dir)}`)
  return [
    "Review-only proposals distilled from telemetry. Nothing is applied by merging this PR's branch alone;",
    "a human applies what they review.",
    "",
    ...entries,
  ].join("\n")
}

const prUrl = (stdout: string): string | undefined =>
  stdout
    .trim()
    .split("\n")
    .find((line) => /^https?:\/\//.test(line))

const readTelemetry = async (cwd: string, file: string): Promise<Telemetry> => {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path.resolve(cwd, file), "utf8"))
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = TelemetrySchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(`Invalid telemetry in ${file}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`)
  return parsed.data
}

const readThreshold = (args: Args, name: string): number | undefined => {
  const raw = flag(args, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Bad --${name}: takes a positive integer.`)
  return value
}

const distillThresholds = (args: Args): DistillThresholds => {
  const minOccurrences = readThreshold(args, "min-occurrences")
  const minRuns = readThreshold(args, "min-runs")
  return {
    ...(minOccurrences !== undefined ? { minOccurrences } : {}),
    ...(minRuns !== undefined ? { minRuns } : {}),
  }
}

const renderStanding = async (
  telemetry: Telemetry,
  thresholds: DistillThresholds,
  out: string,
): Promise<{
  proposals: Proposal[]
  standing: Proposal[]
  dropped: Array<{ proposal: Proposal; reasons: string[] }>
  written: WrittenProposal[]
  droppedFile: string
}> => {
  const proposals = await distillProposals(telemetry, thresholds)
  const standing = undisposed(proposals, telemetry)
  const dropped = disposedWithReasons(proposals, telemetry)
  const rendered = new Map<string, Record<string, string>>()
  const files = await Promise.all(standing.map((proposal) => renderProposalFiles(proposal.cluster)))
  for (const [index, proposal] of standing.entries()) rendered.set(proposal.id, files[index]!.files)
  const written = await writeProposals(out, standing, rendered)
  const droppedFile = await writeDropped(out, dropped)
  return { proposals, standing, dropped, written, droppedFile }
}

const openPr = async (
  args: Args,
  io: ImproveIO,
  root: string,
  written: WrittenProposal[],
  lines: string[],
): Promise<void> => {
  if (args.flags["open-pr"] !== true) return
  if (!io.confirm.interactive) throw new NotInteractive("es improve distill --open-pr")
  const base = flag(args, "base")
  try {
    const opened = await openProposalsPr(
      root,
      written.map((item) => item.dir),
      { ...(base ? { base } : {}) },
    )
    const target = base ?? "current branch"
    lines.push(
      `Draft PR: ${opened.url} (${opened.branch} → ${target}; ${opened.staged.length} proposal(s) staged, base never pushed).`,
    )
  } catch (error) {
    throw new Error(`Could not open a draft PR: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function improveDistill(args: Args, io: ImproveIO, root: string): Promise<number> {
  const telemetryFile = flag(args, "telemetry")
  if (!telemetryFile) {
    io.print("Usage: es improve distill --telemetry <file> --out <dir> [--open-pr] [--base <ref>]")
    return 2
  }
  let telemetry: Telemetry
  try {
    telemetry = await readTelemetry(io.cwd, telemetryFile)
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 1
  }
  let thresholds: DistillThresholds
  try {
    thresholds = distillThresholds(args)
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 2
  }
  const out = flag(args, "out") ? path.resolve(io.cwd, flag(args, "out")!) : factoryLayout(root).improveProposals
  const { proposals, standing, dropped, written, droppedFile } = await renderStanding(telemetry, thresholds, out)
  const disposed = proposals.length - standing.length
  const lines = [
    `Distilled ${proposals.length} proposal(s) (${standing.length} standing, ${disposed} disposed by the gate):`,
    ...written.map((item) => `  ${item.kind} ${item.id} (${item.cluster.occurrences}× ${item.cluster.key})`),
    // Dropped proposals are never silent: each is reported with its reason,
    // and `dropped.json` records them all (S3.5, #136).
    ...(dropped.length > 0
      ? [
          `Disposed by the gate (${dropped.length}):`,
          ...dropped.map(
            (entry) =>
              `  ${entry.proposal.kind} ${entry.proposal.id} (${entry.proposal.cluster.key}): ${entry.reasons.join("; ")}`,
          ),
          `Dropped details: ${path.relative(io.cwd, droppedFile) || droppedFile}.`,
        ]
      : []),
    `Wrote ${written.length} proposal(s) under ${path.relative(io.cwd, out) || out}. Nothing was applied.`,
  ]
  try {
    await openPr(args, io, root, written, lines)
  } catch (error) {
    if (error instanceof NotInteractive) throw error
    io.print([...lines, error instanceof Error ? error.message : String(error)].join("\n"))
    return 1
  }
  io.print(lines.join("\n"))
  return 0
}
