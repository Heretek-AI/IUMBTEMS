// Synthetic trajectory harvester for local model distillation (#175).
//
// Passed + verified phase worktrees become scrubbed, diff-verified SFT/DPO
// datasets for fine-tuning local open-weights coding models (Unsloth /
// Axolotl / Hugging Face chat JSONL). FAIL-CLOSED throughout:
// - Worktrees without caller-attested verification (green gates AND a valid
//   audit chain) are skipped with recorded reasons, never harvested.
// - Missing transcripts, empty diffs and escaping diff paths are skipped
//   with reasons, never exported silently.
// - Every exported string passes secret scrubbing; DPO pairs without a
//   failed attempt are skipped (no invented negatives).
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { exists as fileExists } from "../util/fs.ts"
import { run } from "../util/proc.ts"
export interface TrajectoryTurn {
  readonly role: "user" | "assistant" | "tool"
  readonly content: string
  readonly failed?: true
}

export interface Trajectory {
  readonly id: string
  readonly worktree: string
  readonly phaseId?: string
  readonly verified: true
  readonly turns: readonly TrajectoryTurn[]
  readonly codeDiff: string
  readonly gateFeedback: string
  readonly scrubRedactions: number
}

export interface TrajectorySkip {
  readonly worktree: string
  readonly reason: string
}
/** Caller-attested verification for one worktree (the CLI derives this from gate summaries + the audit chain). */
export interface WorktreeVerification {
  readonly gatesGreen: boolean
  readonly auditValid: boolean
}

export interface WorktreeInput {
  readonly dir: string
  readonly phaseId?: string
  readonly verification: WorktreeVerification
}

export class TrajectoryError extends Error {
  override name = "TrajectoryError"
}

// ------------------------------------------------- secret scrubbing (no regex backtracking surface: single-class patterns + a line scan)

const SCRUBBERS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /(ghp|ghu|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, replacement: "[REDACTED github token]" },
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: "[REDACTED anthropic key]" },
  { pattern: /sk-[A-Za-z0-9]{16,}/g, replacement: "[REDACTED api key]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED aws key]" },
  { pattern: /xox[bpras]-[A-Za-z0-9-]+/g, replacement: "[REDACTED slack token]" },
  { pattern: /Bearer [A-Za-z0-9._~+/=-]+/g, replacement: "[REDACTED bearer token]" },
  {
    pattern: /\b(password|passwd|pwd|secret|api[_-]?key|auth[_-]?token)\b\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|\S+)/gi,
    replacement: "[REDACTED credential]",
  },
]

/** Redact private-key blocks with a line scan (no multi-line regex). */
const scrubKeyBlocks = (lines: string[]): { lines: string[]; redactions: number } => {
  const out: string[] = []
  let redactions = 0
  let inside = false
  for (const line of lines) {
    if (!inside && line.includes("PRIVATE KEY") && line.includes("BEGIN")) {
      inside = true
      redactions++
      out.push("[REDACTED private key]")
      continue
    }
    if (inside) {
      if (line.includes("END")) inside = false
      continue
    }
    out.push(line)
  }
  return { lines: out, redactions }
}

/** Scrub secrets from text; returns the scrubbed text plus the redaction count. */
export function scrubSecretsText(text: string): { text: string; redactions: number } {
  let redactions = 0
  let current = text
  for (const scrubber of SCRUBBERS) {
    scrubber.pattern.lastIndex = 0
    current = current.replace(scrubber.pattern, () => {
      redactions++
      return scrubber.replacement
    })
  }
  const blocked = scrubKeyBlocks(current.split("\n"))
  return { text: blocked.lines.join("\n"), redactions: redactions + blocked.redactions }
}

// ------------------------------------------------- transcript parsing

const ROLES = new Set(["user", "assistant", "tool"])

const parseTranscript = (text: string, worktree: string): TrajectoryTurn[] => {
  const lines = text.split("\n").filter((line) => line.trim())
  if (lines.length === 0)
    throw new TrajectoryError(`worktree ${worktree}: no transcript turns (missing or empty transcript)`)
  return lines.map((line, index) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new TrajectoryError(`worktree ${worktree}: transcript line ${index + 1} is not JSON`)
    }
    if (typeof parsed !== "object" || parsed === null)
      throw new TrajectoryError(`worktree ${worktree}: transcript line ${index + 1} is not an object`)
    const record = parsed as { role?: unknown; content?: unknown; failed?: unknown }
    if (!ROLES.has(record.role as string) || typeof record.content !== "string" || !record.content.trim())
      throw new TrajectoryError(
        `worktree ${worktree}: transcript line ${index + 1} needs a valid role and non-empty content`,
      )
    if (record.failed !== undefined && record.failed !== true)
      throw new TrajectoryError(`worktree ${worktree}: transcript line ${index + 1} has an invalid failed flag`)
    const turn: TrajectoryTurn = { role: record.role as TrajectoryTurn["role"], content: record.content }
    return record.failed === true ? { ...turn, failed: true as const } : turn
  })
}

// ------------------------------------------------- diff verification

/** Fail-closed diff check: non-empty, no escaping paths, new files must exist. */
const verifyDiff = async (diff: string, dir: string, exists: (file: string) => Promise<boolean>): Promise<string> => {
  if (!diff.trim()) throw new TrajectoryError(`worktree ${dir}: empty diff (nothing to distill)`)
  const plusPrefix = "+++ "
  let files = 0
  for (const line of diff.split("\n")) {
    if (!line.startsWith(plusPrefix) || line === "+++ /dev/null") continue
    files++
    const raw = line.slice(plusPrefix.length).trim().replace(/^b\//, "")
    if (!raw || raw.startsWith("/") || raw.split("/").includes(".."))
      throw new TrajectoryError(`worktree ${dir}: diff path escapes the workspace: ${raw || line}`)
  }
  if (files === 0) throw new TrajectoryError(`worktree ${dir}: diff names no files`)
  // New files (`--- /dev/null`) must exist in the worktree: the diff is
  // verified against the tree, not trusted blindly.
  const blocks = diff.split("diff --git ")
  for (const block of blocks) {
    if (!block.includes("--- /dev/null")) continue
    const plus = block
      .split("\n")
      .find((line) => line.startsWith("+++ b/"))
      ?.slice("+++ b/".length)
      .trim()
    if (plus && !(await exists(`${dir}/${plus}`)))
      throw new TrajectoryError(`worktree ${dir}: diff adds missing file ${plus}`)
  }
  return diff
}

// ------------------------------------------------- harvesting

export interface HarvestReaders {
  /** Transcript JSONL for a worktree; defaults to on-disk discovery. */
  readonly readTranscript?: (dir: string, phaseId?: string) => Promise<string>
  /** Unified diff of the phase work; defaults to `git diff HEAD`. */
  readonly readDiff?: (dir: string) => Promise<string>
  readonly exists?: (file: string) => Promise<boolean>
}

export interface TrajectoryHarvest {
  readonly trajectories: Trajectory[]
  readonly skipped: TrajectorySkip[]
}

const TRANSCRIPT_CANDIDATES = (dir: string, phaseId?: string): string[] => [
  ...(phaseId ? [`${dir}/.factory/transcripts/${phaseId}.jsonl`] : []),
  `${dir}/.factory/transcripts/trajectory.jsonl`,
  `${dir}/trajectory.jsonl`,
]

const defaultTranscript = async (dir: string, phaseId?: string): Promise<string> => {
  for (const file of TRANSCRIPT_CANDIDATES(dir, phaseId)) {
    const content = await readFile(file, "utf8").catch(() => undefined)
    if (content !== undefined) return content
  }
  return ""
}

const defaultDiff = async (dir: string): Promise<string> => {
  const result = await run(["git", "-C", dir, "diff", "--no-color", "HEAD", "--", "."], {
    cwd: dir,
    timeoutMs: 30_000,
    sandbox: "none",
  })
  if (result.code !== 0) throw new TrajectoryError(`worktree ${dir}: git diff failed (not a worktree?)`)
  return result.stdout
}

const defaultExists = async (file: string): Promise<boolean> => fileExists(file)

/**
 * Harvest trajectories from phase worktrees. Only worktrees whose
 * verification attests green gates AND a valid audit chain are harvested;
 * everything else is skipped with a recorded reason.
 */
export async function harvestTrajectories(
  input: { worktrees: readonly WorktreeInput[] } & HarvestReaders,
): Promise<TrajectoryHarvest> {
  const readTranscript = input.readTranscript ?? defaultTranscript
  const readDiff = input.readDiff ?? defaultDiff
  const exists = input.exists ?? defaultExists
  const trajectories: Trajectory[] = []
  const skipped: TrajectorySkip[] = []
  for (const worktree of input.worktrees) {
    try {
      if (!worktree.verification.gatesGreen || !worktree.verification.auditValid) {
        const why = [
          ...(!worktree.verification.gatesGreen ? ["gates not green"] : []),
          ...(!worktree.verification.auditValid ? ["audit chain invalid"] : []),
        ].join(" and ")
        throw new TrajectoryError(`worktree ${worktree.dir}: unverified (${why})`)
      }
      const turns = parseTranscript(await readTranscript(worktree.dir, worktree.phaseId), worktree.dir)
      const rawDiff = await readDiff(worktree.dir)
      const codeDiff = await verifyDiff(rawDiff, worktree.dir, exists)
      const gateFeedback = turns
        .filter((turn) => turn.role === "tool")
        .map((turn) => turn.content)
        .join("\n")
      let redactions = 0
      const scrubbed = turns.map((turn) => {
        const result = scrubSecretsText(turn.content)
        redactions += result.redactions
        return { ...turn, content: result.text }
      })
      const scrubbedDiff = scrubSecretsText(codeDiff)
      redactions += scrubbedDiff.redactions
      const scrubbedFeedback = scrubSecretsText(gateFeedback)
      redactions += scrubbedFeedback.redactions
      const id = `${worktree.dir.split("/").filter(Boolean).pop() ?? "worktree"}${worktree.phaseId ? `:${worktree.phaseId}` : ""}`
      trajectories.push({
        id,
        worktree: worktree.dir,
        ...(worktree.phaseId ? { phaseId: worktree.phaseId } : {}),
        verified: true,
        turns: scrubbed,
        codeDiff: scrubbedDiff.text,
        gateFeedback: scrubbedFeedback.text,
        scrubRedactions: redactions,
      })
    } catch (error) {
      skipped.push({
        worktree: worktree.dir,
        reason: error instanceof TrajectoryError ? error.message : `worktree ${worktree.dir}: ${String(error)}`,
      })
    }
  }
  return { trajectories, skipped }
}

// ------------------------------------------------- SFT / DPO formatting (Unsloth / Axolotl / HF chat JSONL)

export interface SftRecord {
  readonly messages: ReadonlyArray<{ role: string; content: string }>
}

/** Chat messages: tool turns fold into user context (chat templates speak user/assistant). */
export function toSft(trajectory: Trajectory): SftRecord {
  const messages: Array<{ role: string; content: string }> = []
  for (const turn of trajectory.turns) {
    if (turn.role === "tool") {
      const prior = messages[messages.length - 1]
      const folded = `[tool feedback] ${turn.content}`
      if (prior && prior.role === "user") prior.content += `\n${folded}`
      else messages.push({ role: "user", content: folded })
      continue
    }
    messages.push({ role: turn.role, content: turn.content })
  }
  return { messages }
}

export interface DpoRecord {
  readonly prompt: string
  readonly chosen: string
  readonly rejected: string
}

/** DPO pair: first user turn as prompt, final assistant turn as chosen, earliest failed attempt as rejected. */
export function toDpo(trajectory: Trajectory): DpoRecord {
  const prompt = trajectory.turns.find((turn) => turn.role === "user")?.content
  const assistants = trajectory.turns.filter((turn) => turn.role === "assistant")
  const chosen = assistants[assistants.length - 1]?.content
  const rejected = assistants.find((turn) => turn.failed === true)?.content
  if (!prompt || !chosen)
    throw new TrajectoryError(`trajectory ${trajectory.id}: needs a user prompt and an assistant answer`)
  if (!rejected)
    throw new TrajectoryError(`trajectory ${trajectory.id}: no failed attempt to use as the rejected response`)
  return { prompt, chosen, rejected }
}

// ------------------------------------------------- export

export interface ExportOptions {
  readonly format: string
  readonly kind: "sft" | "dpo"
  readonly output: string
}

export interface ExportResult {
  readonly records: number
  readonly skipped: TrajectorySkip[]
  readonly manifest: string
}

/**
 * Export trajectories to `<output>` (JSONL) plus `<output>.manifest.json`
 * (provenance: format, kind, record count, every skip with its reason).
 * Unknown formats throw; DPO pairs without negatives are skipped, never invented.
 */
export async function exportDataset(
  trajectories: readonly Trajectory[],
  options: ExportOptions,
): Promise<ExportResult> {
  if (options.format !== "jsonl")
    throw new TrajectoryError(`unknown dataset format: ${options.format} (supports: jsonl)`)
  if (options.kind !== "sft" && options.kind !== "dpo")
    throw new TrajectoryError(`unknown dataset kind: ${String(options.kind)} (supports: sft, dpo)`)
  const lines: string[] = []
  const skipped: TrajectorySkip[] = []
  for (const trajectory of trajectories) {
    try {
      lines.push(JSON.stringify(options.kind === "sft" ? toSft(trajectory) : toDpo(trajectory)))
    } catch (error) {
      skipped.push({
        worktree: trajectory.worktree,
        reason: error instanceof TrajectoryError ? error.message : String(error),
      })
    }
  }
  await mkdir(path.dirname(options.output), { recursive: true })
  await writeFile(options.output, lines.length > 0 ? `${lines.join("\n")}\n` : "")
  const manifest = `${options.output}.manifest.json`
  const body = {
    format: options.format,
    kind: options.kind,
    records: lines.length,
    skipped: skipped.map((entry) => ({ worktree: entry.worktree, reason: entry.reason })),
    generator: "es improve export-dataset",
  }
  await writeFile(manifest, `${JSON.stringify(body, null, 2)}\n`)
  return { records: lines.length, skipped, manifest }
}
