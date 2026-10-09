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
  distillProposals,
  factoryLayout,
  flag,
  git,
  harvestTelemetry,
  type Proposal,
  renderProposalFiles,
  run,
  TelemetrySchema,
  undisposed,
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
    io.print(
      `Harvested ${telemetry.runs.length} run(s) and ${telemetry.evals.length} eval(s) to ${path.relative(io.cwd, file) || file} (telemetry v${telemetry.version}).`,
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
  if (current.code !== 0) throw new Error("cannot determine the current branch")
  const base = options.base ?? current.stdout.trim()
  if (!base) throw new Error("cannot determine the PR base branch")
  const created = await git(root, ["checkout", "-b", branch])
  if (created.code !== 0) throw new Error(`cannot create branch ${branch}: ${created.stderr.trim()}`)
  const staged = [...proposalDirs].sort()
  const added = await git(root, ["add", "--", ...staged])
  if (added.code !== 0) throw new Error(`cannot stage proposals: ${added.stderr.trim()}`)
  const committed = await git(root, ["commit", "-q", "-m", `Distilled improvement proposals (${staged.length})`])
  if (committed.code !== 0) throw new Error(`cannot commit proposals: ${committed.stderr.trim()}`)
  const pushed = await git(root, ["push", "--set-upstream", "origin", `${branch}:${branch}`])
  if (pushed.code !== 0) throw new Error(`cannot push ${branch} (the base branch ${base} is never pushed)`)
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
    `Review-only proposals distilled from telemetry. Nothing is applied by merging this PR's branch alone; a human applies what they review.\n\n${staged.map((dir) => `- ${path.relative(root, dir)}`).join("\n")}`,
  ])
  const url = pr.stdout
    .trim()
    .split("\n")
    .find((line) => /^https?:\/\//.test(line))
  if (pr.code !== 0 || !url) throw new Error("gh pr create failed")
  return { branch, url, staged }
}

export async function improveDistill(args: Args, io: ImproveIO, root: string): Promise<number> {
  const telemetryFile = flag(args, "telemetry")
  if (!telemetryFile) {
    io.print("Usage: es improve distill --telemetry <file> --out <dir> [--open-pr] [--base <ref>]")
    return 2
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path.resolve(io.cwd, telemetryFile), "utf8"))
  } catch (error) {
    io.print(`Cannot read ${telemetryFile}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const parsed = TelemetrySchema.safeParse(raw)
  if (!parsed.success) {
    io.print(`Invalid telemetry in ${telemetryFile}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`)
    return 1
  }
  const minOccurrences = flag(args, "min-occurrences") ? Number(flag(args, "min-occurrences")) : undefined
  const minRuns = flag(args, "min-runs") ? Number(flag(args, "min-runs")) : undefined
  if (
    (minOccurrences !== undefined && !(Number.isInteger(minOccurrences) && minOccurrences > 0)) ||
    (minRuns !== undefined && !(Number.isInteger(minRuns) && minRuns > 0))
  ) {
    io.print("Bad thresholds: --min-occurrences and --min-runs take positive integers.")
    return 2
  }
  const proposals = await distillProposals(parsed.data, {
    ...(minOccurrences !== undefined ? { minOccurrences } : {}),
    ...(minRuns !== undefined ? { minRuns } : {}),
  })
  const standing = undisposed(proposals, parsed.data)
  const disposed = proposals.length - standing.length
  const out = flag(args, "out") ? path.resolve(io.cwd, flag(args, "out")!) : factoryLayout(root).improveProposals
  const rendered = new Map<string, Record<string, string>>()
  for (const proposal of standing) rendered.set(proposal.id, (await renderProposalFiles(proposal.cluster)).files)
  const written = await writeProposals(out, standing, rendered)
  const lines = [
    `Distilled ${proposals.length} proposal(s) (${standing.length} standing, ${disposed} disposed by the gate):`,
    ...written.map(
      (item: Proposal & { dir: string }) =>
        `  ${item.kind} ${item.id} (${item.cluster.occurrences}× ${item.cluster.key})`,
    ),
    `Wrote ${written.length} proposal(s) under ${path.relative(io.cwd, out) || out}. Nothing was applied.`,
  ]
  if (args.flags["open-pr"] === true) {
    if (!io.confirm.interactive) throw new NotInteractive("es improve distill --open-pr")
    try {
      const base = flag(args, "base")
      const opened = await openProposalsPr(
        root,
        written.map((item) => item.dir),
        { ...(base ? { base } : {}) },
      )
      lines.push(
        `Draft PR: ${opened.url} (${opened.branch} → ${base ?? "current branch"}; ${opened.staged.length} proposal(s) staged, base never pushed).`,
      )
    } catch (error) {
      io.print(
        [...lines, `Could not open a draft PR: ${error instanceof Error ? error.message : String(error)}`].join("\n"),
      )
      return 1
    }
  }
  io.print(lines.join("\n"))
  return 0
}
