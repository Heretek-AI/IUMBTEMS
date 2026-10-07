// The phase-03 write surface (adapted from d66328c:runner/queereye/harvest.py):
// the canonical manifest, the skill bundle and the factory cite-gate receipt,
// exercised through the real es_design_harvest tool.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AXES,
  bundleFiles,
  bundlePath,
  canonicalIndentedJson,
  designPaths,
  designTools,
  FORMS,
  harvestBytesSha256,
  harvestManifest,
  verifyCiteGate,
} from "../src/index.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-bundle-"))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const tools = () => designTools({ root })
const call = (name: string, input: Record<string, unknown>, agent = "designer") =>
  tools()
    .find((tool) => tool.name === name)!
    .execute(input, { agent })

/** Skip the whole interview through the tools so tokens.json exists. */
const completeInterview = async () => {
  for (const axis of AXES) for (const slot of FORMS[axis].requiredSlots) await call("es_design_skip", { axis, slot })
  await call("es_design_complete", {})
}

describe("the harvest manifest", () => {
  test("canonicalIndentedJson sorts keys recursively and ends with a newline", () => {
    expect(canonicalIndentedJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n',
    )
    expect(canonicalIndentedJson([])).toBe("[]\n")
  })

  test("the manifest binds the ledger, closure, MIT bytes and dossier hashes", () => {
    const manifest = harvestManifest()
    expect(Object.keys(manifest)).toEqual([
      "ledger",
      "transitive_closure",
      "negative_knowledge",
      "license_bytes_sha256",
      "evidence",
      "distribution",
    ])
    expect((manifest.ledger as unknown[]).length).toBeGreaterThanOrEqual(4)
    expect(harvestBytesSha256()).toBe(harvestBytesSha256(harvestManifest()))
    expect(canonicalIndentedJson(manifest).startsWith('{\n  "distribution"')).toBe(true)
  })

  test("the bundle ships the skill, references, license and a check script", () => {
    const files = bundleFiles()
    expect(Object.keys(files)).toEqual([
      "skill/SKILL.md",
      "skill/references/checklists.md",
      "skill/references/a11y-rules.md",
      "skill/assets/MIT-LICENSE.txt",
      "skill/scripts/harvest-check.ts",
    ])
    expect(files["skill/assets/MIT-LICENSE.txt"]).toContain("MIT License")
    expect(files["skill/scripts/harvest-check.ts"]).toContain("validateLedger")
    expect(files["skill/scripts/harvest-check.ts"]).not.toContain("python")
  })
})

describe("es_design_harvest", () => {
  test("writes the ledger bundle and a verifying cite-gate receipt", async () => {
    await completeInterview()
    const result = await call("es_design_harvest", {})
    expect(result).toContain("Phase-03 written")
    expect(result).toContain("cite-gate receipt verifies")

    const harvest = await readFile(designPaths(root).harvest, "utf8")
    expect(harvest).toBe(canonicalIndentedJson(harvestManifest()))
    expect(await readFile(bundlePath(root, "skill/SKILL.md"), "utf8")).toBe(bundleFiles()["skill/SKILL.md"])
    expect(await readFile(bundlePath(root, "skill-claude/SKILL.md"), "utf8")).toContain("overlay=skill-claude")

    const receipt = await readFile(bundlePath(root, "cite-gate-demo.md"), "utf8")
    expect(receipt).toContain("harvest.json sha256:")
    expect(await verifyCiteGate(receipt, root)).toEqual([])

    // check mode is clean right after a write.
    expect(await call("es_design_harvest", { check: true })).toContain("byte-match")

    // A stale receipt (tokens changed underneath) is refused.
    const tokens = JSON.parse(await readFile(designPaths(root).tokens, "utf8")) as Record<string, unknown>
    tokens.$edited = true
    await writeFile(designPaths(root).tokens, `${JSON.stringify(tokens, null, 2)}\n`)
    expect(await verifyCiteGate(receipt, root)).toContainEqual(expect.stringContaining("stale/forged receipt refused"))
  })

  test("hand edits to the bundle or ledger are drift", async () => {
    await completeInterview()
    await call("es_design_harvest", {})
    await writeFile(bundlePath(root, "skill/references/checklists.md"), "edited by hand\n")
    await expect(call("es_design_harvest", { check: true })).rejects.toThrow(/checklists\.md \(differs/)
    await writeFile(bundlePath(root, "skill/references/checklists.md"), bundleFiles()["skill/references/checklists.md"])
    const ledger = await readFile(designPaths(root).harvest, "utf8")
    await writeFile(designPaths(root).harvest, ledger.replace("copy-own", "copy-own (edited)"))
    await expect(call("es_design_harvest", { check: true })).rejects.toThrow(/harvest\.json \(differs/)
  })

  test("the receipt defers until the token tree exists, and the seat is enforced", async () => {
    const deferred = await call("es_design_harvest", {})
    expect(deferred).toContain("Phase-03 written")
    expect(deferred).toContain("cite-gate receipt deferred")
    await expect(call("es_design_harvest", {}, "es-programmer")).rejects.toThrow(/designer seat/)
  })
})
