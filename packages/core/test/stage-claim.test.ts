// Stage-gating claim wording (#223.1): the "every tool refuses an
// out-of-order step" claim is overbroad as worded — many tools are
// intentionally stage-free (seat-gated, not stage-gated). The claim must be
// narrowed to the phase-transition tools. The pre-QA audit-tiebreak design
// itself is kept (pinned by codeaudit.test.ts: the manager breaks a split
// verdict outside QA); only the wording changes here.
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const text = (rel: string) => readFile(path.join(root, rel), "utf8")

describe("stage-gating claim wording (#223.1)", () => {
  test("README narrows the refusal claim to phase-transition tools", async () => {
    const readme = await text("README.md")
    expect(readme).not.toContain("every `es_*` tool refuses an out-of-order step")
    expect(readme).toContain("phase-transition")
  })

  test("the factory prompt already scopes refusal to phase-transition tools", async () => {
    const prompt = await text("packages/core/assets/prompts/factory.md")
    expect(prompt).toContain("phase-transition tools refuse an out-of-order step")
  })

  test("SYSTEM_ARCHITECTURE scopes refusal to transitions", async () => {
    const arch = await text("SYSTEM_ARCHITECTURE.md")
    expect(arch).toContain("refuses out-of-order steps")
    expect(arch).not.toContain("every `es_*` tool refuses")
  })
})
