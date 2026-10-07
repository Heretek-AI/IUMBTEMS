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
import { readJson, writeJson } from "../util/fs.ts"
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
export function controlClass(relative: string): ControlClass | undefined {
  const normalized = relative.replace(/^\.\//, "")
  const inner = /^\.factory\/worktrees\/[^/]+\/(.+)$/.exec(normalized)?.[1]
  for (const candidate of inner ? [normalized, inner] : [normalized]) {
    if (matchAny(candidate, FACTORY_CONTROL)) return "factory"
    if (matchAny(candidate, CONFIG_CONTROL)) return "config"
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
  const baseline: ControlBaseline = {
    version: 1,
    files: await snapshotControl(root),
    updatedAt: new Date().toISOString(),
    updatedBy,
  }
  await writeJson(factoryLayout(root).control, baseline)
  return baseline
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
