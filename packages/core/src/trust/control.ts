// Control files: the artifacts that make the factory's guarantees mechanical.
// "factory" controls are deny-write for every agent. "config" controls (host
// config, hook definitions) are deny for factory seats and ask-the-human for
// other agents, because editing them is a normal part of human-driven work and
// hooks only run after their content hash is approved anyway.
//
// A baseline of control-file hashes lives in runtime/control.json. Only system
// code acting for a human (approvals, waivers, trust, frontier writes) updates
// it; every gate run and transition verifies it and halts on drift.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"
import { matchAny } from "../util/glob.ts"
import { sha256 } from "../util/hash.ts"

export const FACTORY_CONTROL = [
  ".factory/gates.json",
  ".factory/config.json",
  ".factory/frontier.json",
  ".factory/waivers/**",
  ".factory/approvals/**",
  ".factory/runtime/**",
  ".factory/STOP",
  ".factory/git-hooks/**",
  // Engine-owned brainstorm/harvest/design state: only the es_* tools write it
  // (through core), so no seat can hand-edit what a gated tool reads back.
  ".factory/brainstorm/*.{json,md}",
  ".factory/harvest/*.{json,md}",
  ".factory/harvest/*/profile.json",
  ".factory/harvest/clean-room/**",
  ".factory/design/*.{json,css,md}",
  ".factory/design/components/**",
  ".factory/design/skill/**",
  ".factory/design/skill-claude/**",
  // Evidence: the content-addressed source cache, the research audit's
  // outputs and the claim ledger. A seat that could write here could forge a
  // source (its file name is just its own sha256) and cite it as VERIFIED.
  ".factory/research/sources/**",
  ".factory/research/{coverage,dossier,brief.pcrb}.json",
  ".factory/claims/**",
  // Code-audit records, dossiers and reports; scout plan, profiles and results.
  ".factory/audits/**",
  ".factory/scout/*.{json,md}",
  ".factory/scout/*/{profile,advisories}.json",
  ".git/config",
  ".git/hooks/**",
] as const

export const CONFIG_CONTROL = [
  "opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
  ".opencode/plugins/**",
  ".opencode/hooks.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
] as const

export type ControlClass = "factory" | "config"

/**
 * Classify a POSIX path relative to the project root. Copies of control files
 * inside a phase worktree (.factory/worktrees/<id>/...) are classified by their
 * path within that worktree, since they would ship on the phase branch.
 */
// Matched case-insensitively: on a case-insensitive volume `.factory/GATES.json`
// is the gates file, so a case variant must not slip past the policy (#45).
const FACTORY_CONTROL_LOWER = FACTORY_CONTROL.map((glob) => glob.toLowerCase())
const CONFIG_CONTROL_LOWER = CONFIG_CONTROL.map((glob) => glob.toLowerCase())

export function controlClass(relative: string): ControlClass | undefined {
  const normalized = relative.replace(/^\.\//, "").toLowerCase()
  const inner = /^\.factory\/worktrees\/[^/]+\/(.+)$/.exec(normalized)?.[1]
  for (const candidate of inner ? [normalized, inner] : [normalized]) {
    if (matchAny(candidate, FACTORY_CONTROL_LOWER)) return "factory"
    if (matchAny(candidate, CONFIG_CONTROL_LOWER)) return "config"
  }
  return undefined
}

export const isControlPath = (relative: string) => controlClass(relative) !== undefined

/** Files whose hashes the baseline pins (existing, tracked control artifacts). */
const PINNED = (root: string) => {
  const layout = factoryLayout(root)
  return [layout.gates, layout.frontier, layout.config]
}

export interface ControlBaseline {
  readonly version: 1
  readonly files: Record<string, string | null>
  readonly updatedAt: string
  readonly updatedBy: string
}

async function hashOrNull(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file))
  } catch (error: any) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

/** Hash the pinned control files plus every approval and waiver record. */
export async function snapshotControl(root: string): Promise<Record<string, string | null>> {
  const layout = factoryLayout(root)
  const { readdir } = await import("node:fs/promises")
  const files: string[] = [...PINNED(root)]
  for (const dir of [layout.approvals, layout.waivers]) {
    try {
      for (const name of await readdir(dir)) if (name.endsWith(".json")) files.push(path.join(dir, name))
    } catch {
      // directory absent: nothing to pin
    }
  }
  const out: Record<string, string | null> = {}
  for (const file of files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    out[path.relative(root, file).split(path.sep).join("/")] = await hashOrNull(file)
  return out
}

/** Record the current control-file hashes. Call only from code acting for a human or the system. */
export async function rebaseline(root: string, updatedBy: string): Promise<ControlBaseline> {
  // Held under the control lock (like repinControl): an interleaved re-pin
  // must not overwrite a fresh baseline with a stale snapshot (#32, CI-only
  // es_build_start refusal with a just-recorded approval missing).
  const file = factoryLayout(root).control
  return withLock(file, async () => {
    const baseline: ControlBaseline = {
      version: 1,
      files: await snapshotControl(root),
      updatedAt: new Date().toISOString(),
      updatedBy,
    }
    await writeJson(file, baseline)
    return baseline
  })
}

/**
 * Re-pin one control file after an agent write (#32). Unlike `rebaseline`,
 * only `rel` is updated, so a concurrent hand edit to another control file
 * (gates.json, config.json) is not absorbed into the baseline: it still shows
 * as drift and halts the run. Acts only when a baseline exists; compare-and-
 * swaps on `expectedOld` (the pin before our write) so a concurrent change to
 * the same file is not silently absorbed either.
 */
export async function repinControl(root: string, rel: string, expectedOld: string | null): Promise<void> {
  const file = factoryLayout(root).control
  await withLock(file, async () => {
    const baseline = await readJson<ControlBaseline>(file)
    if (!baseline) return
    if ((baseline.files[rel] ?? null) !== expectedOld) return
    const current = await hashOrNull(path.join(root, ...rel.split("/")))
    baseline.files[rel] = current
    await writeJson(file, {
      ...baseline,
      updatedAt: new Date().toISOString(),
      updatedBy: `${baseline.updatedBy} + repin:${rel}`,
    })
  })
}

export interface ControlCheck {
  readonly clean: boolean
  readonly violations: readonly string[]
  readonly hasBaseline: boolean
}

/** Compare control files with the baseline. No baseline yet means nothing to compare (clean). */
export async function verifyControl(root: string): Promise<ControlCheck> {
  const baseline = await readJson<ControlBaseline>(factoryLayout(root).control)
  if (!baseline) return { clean: true, violations: [], hasBaseline: false }
  const current = await snapshotControl(root)
  const violations: string[] = []
  const keys = new Set([...Object.keys(baseline.files), ...Object.keys(current)])
  for (const key of [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const before = baseline.files[key] ?? null
    const after = current[key] ?? null
    if (before === after) continue
    if (before === null) violations.push(`${key} appeared outside a human-authorised action`)
    else if (after === null) violations.push(`${key} was deleted`)
    else violations.push(`${key} changed (expected ${before.slice(0, 12)}, found ${after.slice(0, 12)})`)
  }
  return { clean: violations.length === 0, violations, hasBaseline: true }
}
