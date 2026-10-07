// Queereye phase-03 acceptance: harvest ledger + transitive closure + skill
// bundle renderers (port of d66328c:runner/tests/test_queereye_harvest.py).
//
// The legacy suite also covered parity replay, the cite-gate and file I/O;
// those surfaces are not part of this pure port, so their coverage lives with
// the harness that owns them. Everything asserted here is pure:
// validateLedger/validateTransitiveClosure planted violations, the MIT bytes
// hash, SPDX blocks, frontmatter + disclosure budgets and renderer fidelity.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  BODY_BUDGET_TOKENS,
  CLOSED_PLATFORMS,
  DOCUMENTED_CLEANROOM_UPSTREAMS,
  DOSSIER_HASHES,
  disclosureBudgetCheck,
  estimateTokens,
  HARVEST_ROWS,
  LEDGER_EVIDENCE_KINDS,
  LEDGER_REQUIRED_KEYS,
  LEDGER_VERDICTS,
  LICENSE_WHITELIST,
  MANDATED_CLOSURE_DEPS,
  META_BUDGET_TOKENS,
  MIT_LICENSE_TEXT,
  mitLicenseBytesSha256,
  NEGATIVE_KNOWLEDGE_NOTES,
  renderA11yRulesMd,
  renderChecklistsMd,
  renderOverlaySkillMd,
  renderSkillMd,
  SKILL_FRONTMATTER_FIELDS,
  spdxBlockFor,
  specTemplateSection,
  splitFrontmatter,
  TRANSITIVE_DEPS,
  tokenSchemaSection,
  validateLedger,
  validateSkillFrontmatter,
  validateTransitiveClosure,
} from "../src/queereye/ledger.ts"

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")
const has = (errors: readonly string[], needle: string): boolean => errors.some((error) => error.includes(needle))
const cloneRows = (): Array<Record<string, unknown>> =>
  structuredClone(HARVEST_ROWS) as unknown as Array<Record<string, unknown>>
const cloneDeps = (): Array<Record<string, unknown>> =>
  structuredClone(TRANSITIVE_DEPS) as unknown as Array<Record<string, unknown>>
const rowFor = (rows: Array<Record<string, unknown>>, skill: string): Record<string, unknown> =>
  rows.find((row) => row.skill === skill)!

describe("harvest ledger shape (d66328c:runner/queereye/harvest.py)", () => {
  test("the shipped ledger and the transitive closure validate clean", () => {
    expect(validateLedger()).toEqual([])
    expect(validateTransitiveClosure()).toEqual([])
  })

  test("the vendored MIT license bytes hash is pinned", () => {
    expect(MIT_LICENSE_TEXT).toContain("Permission is hereby granted, free of charge")
    expect(new TextEncoder().encode(MIT_LICENSE_TEXT).length).toBe(1115)
    expect(mitLicenseBytesSha256()).toBe("a64acdb4ae2922b0a414bc8629fa06507e6e89629d04e13787db2967975d3c3a")
  })

  test(">=4 MIT rows carry LICENSE-byte pins and SPDX blocks", () => {
    const mitRows = HARVEST_ROWS.filter((row) => row.license === "MIT")
    expect(mitRows.length).toBeGreaterThanOrEqual(4)
    const skills = new Set(mitRows.map((row) => row.skill))
    for (const expected of [
      "open-props-theming",
      "shadcn-patterns",
      "radix-behaviors",
      "tailwind-naming",
      "tailwind-theme",
    ])
      expect(skills.has(expected)).toBe(true)
    for (const row of mitRows) {
      expect(row.license_bytes_sha256).toBe(mitLicenseBytesSha256())
      expect(row.spdx).toContain("SPDX-License-Identifier: MIT")
      expect(row.spdx).toContain(row.upstream)
      expect(row.spdx).toContain(row.evidence_hash)
      expect(row.files.length).toBeGreaterThan(0)
    }
  })

  test("dossier evidence hashes are cited; axe-core is excluded and ARIA is behavior-only", () => {
    const bySkill = new Map(HARVEST_ROWS.map((row) => [row.skill, row]))
    expect(bySkill.get("open-props-theming")!.evidence_hash).toBe("dbe9cbb4")
    expect(bySkill.get("shadcn-patterns")!.evidence_hash).toBe("890dc55a")
    expect(bySkill.get("radix-behaviors")!.evidence_hash).toBe("74144f6a")
    expect(bySkill.get("axe-checks")!.evidence_hash).toBe("d0679fbc")
    expect(DOSSIER_HASHES).toHaveLength(7)
    const axe = bySkill.get("axe-checks")!
    expect(axe.verdict).toBe("clean-room")
    expect(axe.upstream_license).toBe("MPL-2.0")
    expect(bySkill.get("aria-contracts")!.verdict).toBe("clean-room")
  })

  test("no GPL/AGPL bytes are vendored and no BSD/ISC license is claimed without bytes", () => {
    for (const row of HARVEST_ROWS) {
      const upstream = row.upstream_license.toUpperCase()
      if (upstream.startsWith("GPL") || upstream.startsWith("AGPL")) expect(row.verdict).toBe("clean-room")
      expect(["BSD-3-CLAUSE", "ISC"]).not.toContain(row.license.toUpperCase())
    }
  })

  test("the vocabularies and pins are exactly the documented ones", () => {
    expect([...LICENSE_WHITELIST].sort()).toEqual(["Apache-2.0", "BSD-3-Clause", "ISC", "MIT"])
    expect([...LEDGER_VERDICTS].sort()).toEqual(["clean-room", "depend", "skip", "vendor"])
    expect([...LEDGER_EVIDENCE_KINDS].sort()).toEqual(["dossier", "license-bytes", "negative"])
    expect([...DOCUMENTED_CLEANROOM_UPSTREAMS].sort()).toEqual(["MPL-2.0", "W3C-DOCUMENT"])
    expect([...MANDATED_CLOSURE_DEPS].sort()).toEqual([
      "@radix-ui/react-dialog",
      "class-variance-authority",
      "clsx",
      "lucide-react",
      "tailwind-merge",
      "tailwindcss",
    ])
    expect(NEGATIVE_KNOWLEDGE_NOTES.some((note) => note.includes("NEGATIVE_KNOWLEDGE"))).toBe(true)
  })

  test("every row carries exactly the machine keys and no closed platform", () => {
    for (const row of HARVEST_ROWS) {
      expect(Object.keys(row).sort()).toEqual([...LEDGER_REQUIRED_KEYS].sort())
      const blob = JSON.stringify(row).toLowerCase()
      for (const closed of CLOSED_PLATFORMS) expect(blob).not.toContain(closed)
    }
    for (const dep of TRANSITIVE_DEPS) {
      expect(Object.keys(dep).sort()).toEqual(["dep", "license_claim", "risk", "status", "via"])
      const blob = JSON.stringify(dep).toLowerCase()
      for (const closed of CLOSED_PLATFORMS) expect(blob).not.toContain(closed)
    }
  })
})

describe("planted ledger violations", () => {
  test("a GPL/AGPL upstream claiming depend or vendor is refused as clean-room-only", () => {
    for (const [upstream, verdict] of [
      ["GPL-3.0-only", "depend"],
      ["AGPL-3.0-only", "vendor"],
    ] as const) {
      const bad = cloneRows()
      bad[0]!.upstream_license = upstream
      bad[0]!.verdict = verdict
      const errors = validateLedger(bad)
      expect(has(errors, "clean-room-only")).toBe(true)
      expect(has(errors, "copyleft")).toBe(true)
    }
  })

  test("an unwhitelisted row license is rejected (case-insensitive whitelist accepts 'mit')", () => {
    const bad = cloneRows()
    bad[0]!.license = "EVIL"
    expect(has(validateLedger(bad), "whitelist")).toBe(true)
    const lower = cloneRows()
    lower[0]!.license = "mit"
    expect(validateLedger(lower)).toEqual([])
  })

  test("an MPL-2.0 upstream claiming depend is refused (and axe must stay clean-room)", () => {
    const bad = cloneRows()
    bad[0]!.upstream_license = "MPL-2.0"
    bad[0]!.verdict = "depend"
    expect(validateLedger(bad).length).toBeGreaterThan(0)
    const axe = cloneRows()
    const axeRow = rowFor(axe, "axe-checks")
    axeRow.upstream_license = "MPL-2.0"
    axeRow.verdict = "depend"
    const errors = validateLedger(axe)
    expect(has(errors, "unknown license")).toBe(true)
    expect(has(errors, "must be clean-room")).toBe(true)
  })

  test("a missing required key fails", () => {
    const bad = cloneRows()
    delete bad[0]!.evidence_hash
    expect(has(validateLedger(bad), "missing required key 'evidence_hash'")).toBe(true)
  })

  test("a bad evidence kind fails", () => {
    const bad = cloneRows()
    bad[0]!.evidence_kind = "badge"
    expect(has(validateLedger(bad), "must be one of")).toBe(true)
    expect(has(validateLedger(bad), "evidence_kind")).toBe(true)
  })

  test("duplicate skill ids fail", () => {
    const bad = cloneRows().concat(cloneRows().slice(0, 1))
    expect(has(validateLedger(bad), "duplicate")).toBe(true)
  })

  test("a vendor row without an SPDX block fails", () => {
    const bad = cloneRows()
    bad[1]!.verdict = "vendor"
    bad[1]!.spdx = ""
    expect(has(validateLedger(bad), "SPDX")).toBe(true)
  })

  test("badge-only evidence must say HYPOTHESIS or NEGATIVE_KNOWLEDGE", () => {
    const bad = cloneRows()
    rowFor(bad, "tailwind-naming").note = "Token naming conventions rebuilt clean-room."
    expect(has(validateLedger(bad), "HYPOTHESIS")).toBe(true)
  })

  test("badge-launder: dossier hashes are membership-checked and cited in the note", () => {
    const launder = cloneRows()
    launder[0]!.evidence_kind = "dossier"
    launder[0]!.evidence_hash = "badge-says-MIT"
    launder[0]!.note = "Badge claims MIT [VERIFIED: badge-says-MIT]"
    expect(has(validateLedger(launder), "dossier evidence_hash")).toBe(true)
    const uncited = cloneRows()
    rowFor(uncited, "shadcn-patterns").note = "Rebuilt clean-room HYPOTHESIS without verified cite."
    expect(has(validateLedger(uncited), "must cite [VERIFIED:")).toBe(true)
  })

  test("license bytes must be 64-hex, non-zero, and MIT rows pin the vendored bytes", () => {
    const notHex = cloneRows()
    notHex[0]!.license_bytes_sha256 = "not-hex"
    notHex[0]!.spdx = String(notHex[0]!.spdx).replace(mitLicenseBytesSha256(), "not-hex")
    expect(has(validateLedger(notHex), "64-hex")).toBe(true)
    const zeros = cloneRows()
    zeros[0]!.license_bytes_sha256 = "0".repeat(64)
    zeros[0]!.spdx = String(zeros[0]!.spdx).replace(mitLicenseBytesSha256(), "0".repeat(64))
    expect(has(validateLedger(zeros), "0*64")).toBe(true)
    const wrongPin = cloneRows()
    wrongPin[0]!.license_bytes_sha256 = "a".repeat(64)
    wrongPin[0]!.spdx = String(wrongPin[0]!.spdx).replace(mitLicenseBytesSha256(), "a".repeat(64))
    expect(has(validateLedger(wrongPin), "must pin vendored MIT bytes")).toBe(true)
  })

  test("a BSD row with a hardcoded MIT SPDX block is refused", () => {
    const bsd = {
      skill: "bsd-x",
      verdict: "clean-room",
      license: "BSD-3-Clause",
      upstream: "x-up",
      upstream_license: "BSD-3-Clause",
      files: ["a"],
      evidence_hash: "h",
      evidence_kind: "negative",
      license_bytes_sha256: "a".repeat(64),
      spdx: spdxBlockFor("bsd-x", "x-up", "BSD-3-Clause", ["a"], "h", "MIT", "a".repeat(64)),
      note: "HYPOTHESIS BSD bytes pinned rebuild behavior spec clean room upstream bytes vendored",
    }
    expect(has(validateLedger(cloneRows().concat([bsd])), "must emit the row license")).toBe(true)
  })

  test("a GPL skip is refused via the license gate (rebuild proof required)", () => {
    const evil = {
      skill: "evil-skip",
      verdict: "skip",
      license: "MIT",
      upstream: "evil-gpl",
      upstream_license: "GPL-3.0-only",
      files: ["a"],
      evidence_hash: "dbe9cbb4",
      evidence_kind: "dossier",
      license_bytes_sha256: mitLicenseBytesSha256(),
      spdx: spdxBlockFor("evil-skip", "evil-gpl", "GPL-3.0-only", ["a"], "dbe9cbb4"),
      note: "[VERIFIED: dbe9cbb4] rebuild behavior spec clean room upstream bytes vendored dialog focus keyboard",
    }
    expect(has(validateLedger(cloneRows().concat([evil])), "skip refused")).toBe(true)
  })

  test("an unknown SPDX id is refused for clean-room; the documented W3C/MPL exceptions stay green", () => {
    const evil = {
      skill: "evil-cr",
      verdict: "clean-room",
      license: "MIT",
      upstream: "evil",
      upstream_license: "EVIL-MADE-UP",
      files: ["a"],
      evidence_hash: "dbe9cbb4",
      evidence_kind: "dossier",
      license_bytes_sha256: mitLicenseBytesSha256(),
      spdx: spdxBlockFor("evil-cr", "evil", "EVIL-MADE-UP", ["a"], "dbe9cbb4"),
      note: "[VERIFIED: dbe9cbb4] rebuild behavior spec clean room upstream bytes vendored dialog focus keyboard",
    }
    expect(has(validateLedger(cloneRows().concat([evil])), "unknown license")).toBe(true)
    expect(validateLedger()).toEqual([])
  })

  test("MPL-2.0/W3C-Document exceptions are skill-bound and note-bound", () => {
    const impostor = cloneRows()
    const row = rowFor(impostor, "shadcn-patterns")
    row.upstream_license = "MPL-2.0"
    expect(has(validateLedger(impostor), "only for axe-checks")).toBe(true)
    const w3c = cloneRows()
    const w3cRow = rowFor(w3c, "shadcn-patterns")
    w3cRow.upstream_license = "W3C-Document"
    w3cRow.note = "Rebuilt clean-room behavior spec with VERIFIED cites."
    expect(has(validateLedger(w3c), "only for aria-contracts")).toBe(true)
  })

  test("closed platforms are refused in the ledger", () => {
    const bad = cloneRows()
    bad[0]!.note = String(bad[0]!.note) + " knapsack board"
    expect(has(validateLedger(bad), "closed platform")).toBe(true)
  })

  test("files traversal is refused (escape attempts stay errors)", () => {
    for (const evil of ["../../etc/passwd", "/etc/passwd", "skill/../../etc/passwd"]) {
      const bad = cloneRows()
      bad[0]!.files = [evil]
      const errors = validateLedger(bad)
      expect(has(errors, "traversal") || has(errors, "escapes")).toBe(true)
    }
  })

  test("non-object rows and an empty ledger are refused", () => {
    expect(validateLedger([])).toEqual(["harvest ledger must be a non-empty list of rows"])
    expect(has(validateLedger([7]), "row must be an object")).toBe(true)
    expect(validateTransitiveClosure([])).toEqual(["transitive closure must be a non-empty scan list"])
    expect(has(validateTransitiveClosure([7]), "entry must be an object")).toBe(true)
  })
})

describe("the transitive closure (shadcn sub-deps)", () => {
  test("all six mandated sub-deps are scanned via shadcn/ui", () => {
    const via = new Set(TRANSITIVE_DEPS.filter((dep) => dep.via === "shadcn/ui").map((dep) => dep.dep))
    for (const expected of [
      "@radix-ui/react-dialog",
      "tailwindcss",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "lucide-react",
    ])
      expect(via.has(expected)).toBe(true)
  })

  test("lucide-react stays ISC-negative and the BSD gap stays negative", () => {
    const lucide = TRANSITIVE_DEPS.find((dep) => dep.dep === "lucide-react")!
    expect(lucide.status).toBe("negative")
    expect(lucide.risk).toContain("NEGATIVE_KNOWLEDGE")
    expect(NEGATIVE_KNOWLEDGE_NOTES.some((note) => note.includes("NEGATIVE_KNOWLEDGE"))).toBe(true)
  })

  test("a copyleft claim may only enter as negative", () => {
    const bad = cloneDeps().concat([
      { dep: "evil-gpl", via: "shadcn/ui", license_claim: "GPL-3.0-only", status: "priced", risk: "none" },
    ])
    expect(validateTransitiveClosure(bad)).not.toEqual([])
  })

  test("a negative row without a NEGATIVE_KNOWLEDGE/HYPOTHESIS marker fails", () => {
    const bad = cloneDeps()
    bad[0]!.status = "negative"
    bad[0]!.risk = "no problem"
    expect(has(validateTransitiveClosure(bad), "negative status must carry")).toBe(true)
  })

  test("dropping a mandated sub-dep or a negative coverage row fails", () => {
    const dropped = cloneDeps().filter((dep) => dep.dep !== "clsx")
    expect(has(validateTransitiveClosure(dropped), "mandated sub-dep")).toBe(true)
    const noBsd = cloneDeps().filter((dep) => !String(dep.license_claim).includes("BSD"))
    expect(has(validateTransitiveClosure(noBsd), "BSD-negative")).toBe(true)
  })

  test("blank keys, bad statuses and closed platforms are refused", () => {
    const blank = cloneDeps()
    delete blank[0]!.risk
    expect(has(validateTransitiveClosure(blank), "missing/blank required key 'risk'")).toBe(true)
    const status = cloneDeps()
    status[0]!.status = "maybe"
    expect(has(validateTransitiveClosure(status), "must be priced|negative")).toBe(true)
    const closed = cloneDeps()
    closed[0]!.risk = String(closed[0]!.risk) + " supernova"
    expect(has(validateTransitiveClosure(closed), "closed platform")).toBe(true)
  })
})

describe("skill frontmatter and disclosure budgets", () => {
  test("the bundle and overlay frontmatter validate", () => {
    expect(validateSkillFrontmatter(renderSkillMd())).toEqual([])
    expect(validateSkillFrontmatter(renderOverlaySkillMd())).toEqual([])
    expect(disclosureBudgetCheck(renderSkillMd())).toEqual([])
    expect(disclosureBudgetCheck(renderOverlaySkillMd())).toEqual([])
  })

  test("missing name/description and a missing frontmatter block fail", () => {
    expect(SKILL_FRONTMATTER_FIELDS).toContain("name")
    expect(SKILL_FRONTMATTER_FIELDS).toContain("description")
    const withoutName = renderSkillMd().replace("name: queereye-style\n", "")
    expect(has(validateSkillFrontmatter(withoutName), "'name'")).toBe(true)
    const withoutDescription = renderSkillMd().replace(/description: [^\n]*\n/, "")
    expect(has(validateSkillFrontmatter(withoutDescription), "'description'")).toBe(true)
    expect(validateSkillFrontmatter("no frontmatter here").length).toBeGreaterThan(0)
    expect(validateSkillFrontmatter("--- unterminated")).toEqual([
      "skill SKILL.md must open with a --- frontmatter block",
    ])
  })

  test("zero-width-only fields are blank (refused)", () => {
    const sneaky = renderSkillMd().replace("name: queereye-style", "name: \u200b\u200b")
    expect(has(validateSkillFrontmatter(sneaky), "'name'")).toBe(true)
  })

  test("the frontmatter license is whitelist-enforced", () => {
    const bad = renderSkillMd().replace("license: MIT", "license: MPL-2.0")
    expect(has(validateSkillFrontmatter(bad), "whitelist")).toBe(true)
  })

  test("disclosure budgets are met wc-measured, and a bloated body fails", () => {
    const text = renderSkillMd()
    const [fm, body] = splitFrontmatter(text)
    expect(fm).not.toBeNull()
    expect(estimateTokens(Object.values(fm!).join(" "))).toBeLessThanOrEqual(META_BUDGET_TOKENS)
    expect(estimateTokens(body)).toBeLessThan(BODY_BUDGET_TOKENS)
    const bloated = renderSkillMd() + "x".repeat(200 * 1024)
    expect(has(disclosureBudgetCheck(bloated), "body")).toBe(true)
  })

  test("bloated metadata fails and the byte backstop refuses single-word evasion", () => {
    const bad = renderSkillMd().replace(
      "description: Interview-driven living style guide",
      `description: ${"word ".repeat(200)}`,
    )
    expect(has(disclosureBudgetCheck(bad), "metadata")).toBe(true)
    const blob = "x".repeat(200 * 1024)
    expect(estimateTokens(blob)).toBeGreaterThanOrEqual(50000)
    const text = `---\nname: a\ndescription: b\nlicense: MIT\ncompatibility: c\nmetadata: d\nallowed-tools: e\n---\n${blob}`
    expect(has(disclosureBudgetCheck(text), "exceeds")).toBe(true)
  })

  test("estimateTokens matches the legacy wc-style probes", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("a")).toBe(2)
    expect(estimateTokens("a b c")).toBe(4)
    expect(estimateTokens("   ")).toBe(1)
    expect(estimateTokens("x".repeat(200 * 1024))).toBe(51200)
    expect(estimateTokens("word ".repeat(200))).toBe(261)
  })
})

describe("skill bundle renderers", () => {
  test("the four renderers are deterministic; paths are adapted from d66328c to .factory/design/", () => {
    // Golden SHA-256 pins: the legacy renderers with `.queereye/` adapted to
    // `.factory/design/` (the ratified path adaptation). Rule text is legacy.
    const cases: Array<[string, () => string, string]> = [
      ["renderSkillMd", renderSkillMd, "0d641105687e83adf69ecabcd4eb1d9423af7f7af7d36c45a1304461fce767c0"],
      [
        "renderOverlaySkillMd",
        renderOverlaySkillMd,
        "a3a3a780702fda418b1f10c4a33293cdbfe21fbd9a535b263469b599e29d91d2",
      ],
      ["renderChecklistsMd", renderChecklistsMd, "05f1677e89fe711f1dcab7587130691b68dc6e9631de4ace7da823a17585a5b0"],
      ["renderA11yRulesMd", renderA11yRulesMd, "d31e9e161e586352f82663039a3c16e3973f7fe1ae6740cdd2c0a3717905c094"],
    ]
    for (const [name, render, hash] of cases) {
      expect(render(), name).toBe(render())
      expect(sha256(render()), name).toBe(hash)
      expect(render().endsWith("\n"), name).toBe(true)
    }
  })

  test("the bundle and the overlay embed the token schema and spec template exactly once", () => {
    const bundle = renderSkillMd()
    const overlay = renderOverlaySkillMd()
    for (const section of [tokenSchemaSection(), specTemplateSection()]) {
      expect(bundle.split(section)).toHaveLength(2)
      expect(overlay.split(section)).toHaveLength(2)
    }
    expect(overlay).toContain("ca41333c")
    expect(overlay).toContain("aab8ead6")
    expect(bundle).toContain("ca41333c")
    expect(bundle).toContain("aab8ead6")
  })

  test("checklists render the required sections, states, dialog anatomy and cva axes", () => {
    const text = renderChecklistsMd()
    for (const key of ["name", "anatomy", "props", "variants", "slots", "keyboard", "focus", "scroll", "usage"])
      expect(text).toContain(`- \`${key}\``)
    for (const state of ["loading", "empty", "error", "disabled"]) expect(text).toContain(`- \`${state}\``)
    for (const part of ["Root", "Trigger", "Portal", "Overlay", "Content", "Title", "Description", "Close"])
      expect(text).toContain(`- \`${part}\``)
    expect(text).toContain("cva variant axis: `default`, `outline`, `ghost`, `destructive`, `secondary`, `link`")
    expect(text).toContain("cva size axis: `default`, `xs`, `sm`, `lg`, `icon`")
  })

  test("the a11y rules render the gated thresholds (3.0/7.0 formatting preserved)", () => {
    const text = renderA11yRulesMd()
    expect(text).toContain(">=4.5:1")
    expect(text).toContain(">=3.0:1")
    expect(text).toContain("7.0:1")
    expect(text).toContain("axe-core (MPL-2.0) behavior-only")
  })
})

describe("SPDX blocks and row shape", () => {
  test("spdxBlockFor emits the template with the row license and bytes", () => {
    expect(spdxBlockFor("open-props-theming", "open-props", "MIT", ["tokens.css"], "dbe9cbb4")).toBe(
      "SPDX-License-Identifier: MIT\n" +
        "Skill: open-props-theming\n" +
        "Upstream: open-props (claimed MIT)\n" +
        "Files: tokens.css\n" +
        `License-Bytes-SHA256: ${mitLicenseBytesSha256()}\n` +
        "Evidence: dbe9cbb4\n",
    )
  })

  test("spdxBlockFor sorts files and carries a non-MIT row license + own bytes", () => {
    const block = spdxBlockFor("bsd-x", "x-up", "BSD-3-Clause", ["b.ts", "a.ts"], "h", "BSD-3-Clause", "a".repeat(64))
    expect(block).toContain("SPDX-License-Identifier: BSD-3-Clause")
    expect(block).toContain("Files: a.ts,b.ts")
    expect(block).toContain(`License-Bytes-SHA256: ${"a".repeat(64)}`)
    expect(spdxBlockFor("s", "u", "MIT", [], "h")).toContain("Files: (no vendored files)")
  })

  test("every shipped row's SPDX block names its upstream and its own license", () => {
    for (const row of HARVEST_ROWS) {
      expect(row.spdx).toContain(`SPDX-License-Identifier: ${row.license}`)
      expect(row.spdx).toContain(`Upstream: ${row.upstream} (claimed ${row.upstream_license})`)
      expect(row.spdx).toContain(`Evidence: ${row.evidence_hash}`)
    }
  })
})
