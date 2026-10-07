// The phase-03 write surface, adapted from d66328c:runner/queereye/harvest.py
// (harvest_manifest, skill_bundle_files, render_receipt, verify_cite_gate).
// The ratified adaptation: `.queereye/` paths become `.factory/design/`, and
// the bundle's check script is TypeScript against es-core, not vendored
// Python (spec §1: no Python runtime, no runner/*.py vendoring).
import { readFile } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { sha256, sortKeys } from "../util/hash.ts"
import {
  DOSSIER_HASHES,
  HARVEST_ROWS,
  MIT_LICENSE_TEXT,
  mitLicenseBytesSha256,
  NEGATIVE_KNOWLEDGE_NOTES,
  renderA11yRulesMd,
  renderChecklistsMd,
  renderSkillMd,
  TRANSITIVE_DEPS,
  validateLedger,
  validateTransitiveClosure,
} from "./ledger.ts"
import { checkDrift, readProbes } from "./store.ts"

/** Manifest bytes: stable JSON with recursively sorted keys, 2-space indent, trailing newline (Python sort_keys=True). */
export function canonicalIndentedJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

/** The `.factory/design/harvest.json` document (the ledger + closure manifest). */
export function harvestManifest(): Record<string, unknown> {
  return {
    ledger: HARVEST_ROWS.map((row) => ({ ...row })),
    transitive_closure: TRANSITIVE_DEPS.map((dep) => ({ ...dep })),
    negative_knowledge: [...NEGATIVE_KNOWLEDGE_NOTES],
    license_bytes_sha256: mitLicenseBytesSha256(),
    evidence: Object.fromEntries(DOSSIER_HASHES.map((hash, index) => [`hash_${index}`, hash])),
    distribution: "copy-own ledger (no upstream bytes vendored)",
  }
}

/** SHA-256 of the canonical manifest bytes (the ledger binding). */
export function harvestBytesSha256(manifest: Record<string, unknown> = harvestManifest()): string {
  return sha256(canonicalIndentedJson(manifest))
}

/** The skill bundle layout: `{rel: content}` under the design directory. */
export function bundleFiles(): Record<string, string> {
  return {
    "skill/SKILL.md": renderSkillMd(),
    "skill/references/checklists.md": renderChecklistsMd(),
    "skill/references/a11y-rules.md": renderA11yRulesMd(),
    "skill/assets/MIT-LICENSE.txt": MIT_LICENSE_TEXT,
    // Legacy shipped `harvest-check.py`; the 1.x bundle ships a tiny script
    // that validates the ledger through es-core instead (no Python runtime).
    "skill/scripts/harvest-check.ts": `#!/usr/bin/env -S bun
// Validate this bundle's harvest.json with es-core. The legacy Python
// checker is not vendored (1.1 is TypeScript-only).
import { readFileSync } from "node:fs"
import { validateLedger, validateTransitiveClosure } from "@heretek-ai/es-core"
const doc = JSON.parse(readFileSync(new URL("../../harvest.json", import.meta.url), "utf8"))
const errors = [
  ...validateLedger(doc.ledger ?? []),
  ...validateTransitiveClosure(doc.transitive_closure ?? []),
]
if (errors.length) {
  console.error("harvest ledger FAILED:")
  for (const error of errors) console.error(\`  - \${error}\`)
  process.exit(1)
}
console.log("harvest ledger: ok")
`,
  }
}

const DOSSIER_LINE = "dossier: .factory/design/ (design tree: tokens + ledger)"

/** The factory cite-gate demo receipt (deterministic per tokens + ledger). */
export async function renderReceipt(root: string): Promise<string> {
  const tokensFile = factoryLayout(root).designTokens
  const tokens = await readFile(tokensFile).catch((error: Error) => {
    throw new Error(`no tokens.json at ${tokensFile}: ${error.message}`)
  })
  const lines = ["# Queereye factory cite-gate demo receipt", ""]
  lines.push(`tokens.json sha256: ${sha256(tokens.toString("utf8"))}`)
  lines.push("tokens source: .factory/design/tokens.json")
  lines.push("")
  lines.push(`harvest.json sha256: ${harvestBytesSha256()}`)
  lines.push("ledger source: .factory/design/harvest.json")
  lines.push("")
  lines.push("style hashes cited (full quotes in phase dossier):")
  lines.push("")
  for (const hash of DOSSIER_HASHES) lines.push(`- [VERIFIED: ${hash}]`)
  lines.push("")
  lines.push(
    "ledger: .factory/design/harvest.json (machine rows {skill,verdict,license,upstream,files,evidence_hash}; " +
      "SPDX blocks; transitive closure; MIT/Apache-2.0/BSD-3-Clause/ISC enforced).",
  )
  lines.push(DOSSIER_LINE)
  lines.push("")
  return lines.join("\n")
}

// The manifest's ledger + closure must validate before a receipt is trusted;
// the error prefix keeps the QA-gate framing.
const validate = (manifest: Record<string, unknown>): string[] =>
  [
    ...validateLedger((manifest.ledger as unknown[]) ?? []),
    ...validateTransitiveClosure((manifest.transitive_closure as unknown[]) ?? []),
  ].map((error) => `cite-gate QA ledger: ${error}`)

/**
 * Verify a receipt against the live tree: the structured bindings must match
 * the live tokens.json and harvest.json digests (stale receipts are refused),
 * then the QA gates run — contrast probes, render-match drift, ledger and
 * closure validation, and harvest.json freshness against the live manifest.
 */
export async function verifyCiteGate(receipt: string, root: string): Promise<string[]> {
  const errors: string[] = []
  if (typeof receipt !== "string" || !receipt) return ["cite-gate: receipt must be a non-empty string"]
  const tokensFile = factoryLayout(root).designTokens
  const tokensRaw = await readFile(tokensFile, "utf8").catch(() => undefined)
  if (tokensRaw === undefined) return [`cite-gate: no tokens.json at ${tokensFile}`]

  const tokensLine = /^tokens\.json sha256:\s*([0-9a-fA-F]{64})\s*$/m.exec(receipt)
  if (!tokensLine)
    errors.push(
      "cite-gate: receipt missing structured tokens.json sha256 line (programmer MUST cite token hashes in structure; bare substring refused)",
    )
  else if (tokensLine[1]!.toLowerCase() !== sha256(tokensRaw))
    errors.push(
      "cite-gate: receipt tokens.json sha256 does not match the live .factory/design/tokens.json digest (stale/forged receipt refused)",
    )
  if (!receipt.includes("tokens source: .factory/design/tokens.json"))
    errors.push("cite-gate: receipt missing tokens source section")
  if (!receipt.includes("# Queereye factory cite-gate demo receipt"))
    errors.push("cite-gate: receipt missing header section")
  if (!receipt.includes("style hashes cited")) errors.push("cite-gate: receipt missing style-hashes section")

  const ledgerLine = /^harvest\.json sha256:\s*([0-9a-fA-F]{64})\s*$/m.exec(receipt)
  if (!ledgerLine)
    errors.push(
      "cite-gate: receipt missing structured harvest.json sha256 line (ledger binding required; bare substring refused)",
    )
  else if (ledgerLine[1]!.toLowerCase() !== harvestBytesSha256())
    errors.push(
      "cite-gate: receipt harvest.json sha256 does not match the live ledger digest (stale/forged ledger binding refused)",
    )
  if (!receipt.includes("ledger source: .factory/design/harvest.json"))
    errors.push("cite-gate: receipt missing ledger source section")
  if (!receipt.includes(DOSSIER_LINE)) errors.push("cite-gate: receipt missing dossier section")
  for (const hash of DOSSIER_HASHES)
    if (!new RegExp(`\\[VERIFIED:\\s*${hash}\\s*\\]`, "i").test(receipt))
      errors.push(`cite-gate: receipt missing structured dossier hash [VERIFIED: ${hash}]`)

  // QA gate: contrast probes.
  const probes = (await readProbes(root).catch(() => undefined)) ?? []
  for (const row of probes) for (const error of row.errors) errors.push(`cite-gate QA contrast ${row.name}: ${error}`)
  for (const row of probes)
    if (!row.pass && row.errors.length === 0) errors.push(`cite-gate QA contrast ${row.name}: pair does not pass`)

  // QA gate: render-match (style guide + css must be pure renders of tokens).
  const drift = await checkDrift(root)
  for (const file of [...drift.missing, ...drift.drifted])
    errors.push(`cite-gate QA render-match: ${file} differs from the rendered output`)

  // QA gate: ledger + closure, and the on-disk harvest.json must be fresh.
  const manifest = harvestManifest()
  errors.push(...validate(manifest))
  const ledgerPath = factoryLayout(root).designHarvest
  const onDisk = await readFile(ledgerPath, "utf8").catch(() => undefined)
  if (onDisk === undefined) errors.push("cite-gate QA ledger: harvest.json missing (run es_design_harvest)")
  else if (onDisk !== canonicalIndentedJson(manifest))
    errors.push("cite-gate QA ledger: harvest.json drifted from the live ledger (freshness refused)")
  return errors
}

/** Where a bundle-relative path lands under the design directory. */
export const bundlePath = (root: string, rel: string): string => path.join(factoryLayout(root).design, rel)
