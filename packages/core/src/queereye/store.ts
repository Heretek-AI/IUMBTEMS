// The `.factory/design/` filesystem contract: hard error outside, idempotent
// atomic writes, user-customized files never overwritten (versioned backup +
// conflict note instead), and interview state persisted incrementally so a
// killed session resumes.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import type { DesignAnswers, ProbeRow } from "../schema/queereye.ts"
import { DesignAnswersSchema, ProbeRowSchema } from "../schema/queereye.ts"
import { canonicalPath, relativeTo } from "../trust/paths.ts"
import { atomicWrite, readJson, withLock } from "../util/fs.ts"
import { compileToCssVars, renderGuide } from "./render.ts"
import type { SlotLoop } from "./slots.ts"
import { validateTokens } from "./tokens.ts"

export class DesignPathError extends Error {}
export class DesignCorruptError extends Error {}

export function designPaths(root: string) {
  const layout = factoryLayout(root)
  return {
    dir: layout.design,
    interview: layout.designInterview,
    tokens: layout.designTokens,
    css: layout.designCss,
    probes: layout.designProbes,
    guide: layout.designGuide,
  }
}

/** Resolve a path inside the design directory or raise (hard error outside). */
export function resolveInside(root: string, rel: string): string {
  const dir = canonicalPath(designPaths(root).dir)
  const candidate = canonicalPath(path.resolve(dir, rel))
  const inner = relativeTo(dir, candidate)
  if (inner === undefined) throw new DesignPathError(`refusing write outside .factory/design/: ${rel}`)
  if (inner === ".") throw new DesignPathError(`refusing write to .factory/design/ itself: ${rel}`)
  return candidate
}

export interface WriteOutcome {
  readonly wrote: boolean
  readonly backup?: string
  readonly note?: string
}

/**
 * Write only when bytes differ. Machine files overwrite atomically;
 * user-owned files are never overwritten — a `<name>.bak.<hash>` copy is
 * written and a conflict note returned.
 */
export async function writeIfChanged(
  file: string,
  content: string,
  options: { userOwned?: boolean } = {},
): Promise<WriteOutcome> {
  const existing = await readFile(file, "utf8").catch(() => undefined)
  if (existing !== undefined && existing === content) return { wrote: false }
  if (existing !== undefined && options.userOwned) {
    const backup = `${file}.bak.${createHash("sha256").update(existing).digest("hex").slice(0, 12)}`
    await atomicWrite(backup, existing)
    return {
      wrote: false,
      backup,
      note: `conflict: ${path.basename(file)} is user-customized; left untouched, existing bytes preserved in ${path.basename(backup)}`,
    }
  }
  await withLock(file, async () => {
    await atomicWrite(file, content)
  })
  return { wrote: true }
}

/** Persist interview.json + incremental tokens.json for resume (idempotent). */
export async function saveInterview(root: string, loop: SlotLoop): Promise<WriteOutcome[]> {
  const paths = designPaths(root)
  const state: DesignAnswers = {
    values: Object.fromEntries(Object.entries(loop.values).map(([axis, values]) => [axis, { ...values }])),
    skipped: Object.fromEntries(
      Object.entries(loop.skipped).map(([axis, skipped]) => [
        axis,
        [...skipped].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    ),
  }
  const errors = validateTokens(loop.toTokens())
  if (errors.length) state.token_errors = errors
  const outcomes = [await writeIfChanged(paths.interview, `${JSON.stringify(state, null, 2)}\n`)]
  outcomes.push(await writeIfChanged(paths.tokens, `${JSON.stringify(loop.toTokens(), null, 2)}\n`))
  return outcomes
}

/** Restore values/skipped from interview.json; false on a fresh start. */
export async function loadInterview(root: string, loop: SlotLoop): Promise<boolean> {
  const file = designPaths(root).interview
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error?.code === "ENOENT") return undefined
    throw new DesignCorruptError(
      `corrupt interview.json at ${file}: cannot read (${error.message}); restore from backup or delete it to restart`,
    )
  })
  if (text === undefined) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DesignCorruptError(
      `corrupt interview.json at ${file}: ${error instanceof Error ? error.message : String(error)}; restore from backup or delete it to restart`,
    )
  }
  const result = DesignAnswersSchema.safeParse(parsed)
  if (!result.success)
    throw new DesignCorruptError(
      `corrupt interview.json at ${file}: ${result.error.message}; restore from backup or delete it to restart`,
    )
  for (const axis of Object.keys(loop.values) as Array<keyof typeof loop.values>) {
    loop.values[axis] = { ...(result.data.values[axis] ?? {}) }
    loop.skipped[axis] = new Set(result.data.skipped[axis] ?? [])
  }
  return true
}

export async function readTokens(root: string): Promise<unknown | undefined> {
  const file = designPaths(root).tokens
  const raw = await readJson(file).catch((error: Error) => {
    throw new DesignCorruptError(`corrupt tokens.json at ${file}: ${error.message}; re-run the renderer`)
  })
  return raw
}

export async function readProbes(root: string): Promise<ProbeRow[] | undefined> {
  const raw = await readJson(designPaths(root).probes)
  if (raw === undefined) return undefined
  const parsed = ProbeRowSchema.array().safeParse(raw)
  if (!parsed.success) throw new DesignCorruptError(`corrupt probes.json: ${parsed.error.message}; re-run the renderer`)
  return parsed.data
}

/** Write the machine-owned design artifacts (tokens, probes, css, guide). */
export async function writeArtifacts(
  root: string,
  artifacts: { tokens: unknown; probes: readonly ProbeRow[]; guide: string; css: string },
): Promise<WriteOutcome[]> {
  const paths = designPaths(root)
  return [
    await writeIfChanged(paths.tokens, `${JSON.stringify(artifacts.tokens, null, 2)}\n`),
    await writeIfChanged(paths.probes, `${JSON.stringify(artifacts.probes, null, 2)}\n`),
    await writeIfChanged(paths.css, artifacts.css),
    await writeIfChanged(paths.guide, artifacts.guide),
  ]
}

export interface DriftReport {
  readonly drifted: readonly string[]
  readonly missing: readonly string[]
  readonly tokenErrors: readonly string[]
}

/** Re-render from tokens.json + probes.json and compare with the committed files. */
export async function checkDrift(root: string): Promise<DriftReport> {
  const paths = designPaths(root)
  const tokens = await readTokens(root)
  if (tokens === undefined) return { drifted: [], missing: [path.basename(paths.tokens)], tokenErrors: [] }
  const probes = (await readProbes(root)) ?? []
  const expected = new Map<string, string>([
    [paths.css, compileToCssVars(tokens)],
    [paths.guide, renderGuide(tokens, probes)],
  ])
  const drifted: string[] = []
  const missing: string[] = []
  for (const [file, content] of expected) {
    const existing = await readFile(file, "utf8").catch(() => undefined)
    if (existing === undefined) missing.push(path.basename(file))
    else if (existing !== content) drifted.push(path.basename(file))
  }
  return { drifted, missing, tokenErrors: validateTokens(tokens) }
}
