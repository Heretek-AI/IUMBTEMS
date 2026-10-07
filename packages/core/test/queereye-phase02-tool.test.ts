// The phase-02 write surface through the real es_design_specs tool: component
// specs, the pinned webref snapshot, the CSF play-harness manifest and the TUI
// lowering notes (adapted from d66328c:runner/queereye/{specs,webref,csf,tui}.py).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { bundlePath, designPaths, designTools, EXEMPLARS, specFilename } from "../src/index.ts"
import { isWebrefFresh } from "../src/queereye/webref.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-phase02-"))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const call = (name: string, input: Record<string, unknown> = {}, agent = "designer") =>
  designTools({ root })
    .find((tool) => tool.name === name)!
    .execute(input, { agent })

describe("es_design_specs", () => {
  test("writes six component specs, webref, csf and tui-notes; check mode is clean", async () => {
    const result = await call("es_design_specs", {})
    expect(result).toContain("Phase-02 written")
    expect(result).toContain("6 component spec")
    expect(result).toContain("pass rate 1.00")

    for (const name of Object.keys(EXEMPLARS)) {
      const text = await readFile(bundlePath(root, specFilename(name)), "utf8")
      expect(`${name} spec length: ${text.length > 500}`).toBe(`${name} spec length: true`)
    }
    const csf = JSON.parse(await readFile(designPaths(root).csf, "utf8")) as {
      play_pass_rate: number
      stories: unknown[]
      specs: string[]
    }
    expect(csf.play_pass_rate).toBe(1)
    expect(csf.specs).toEqual(Object.keys(EXEMPLARS).sort())
    expect(csf.stories.length).toBeGreaterThan(0)
    const webref = JSON.parse(await readFile(designPaths(root).webref, "utf8")) as Record<string, unknown>
    expect(Object.keys(webref).length).toBeGreaterThan(0)
    expect(await readFile(designPaths(root).tuiNotes, "utf8")).toContain("NEGATIVE_KNOWLEDGE")

    expect(await call("es_design_specs", { check: true })).toContain("byte-match")
    expect(isWebrefFresh()).toBe(true)
  })

  test("hand edits to a component spec or to tui-notes are drift", async () => {
    await call("es_design_specs", {})
    const button = bundlePath(root, specFilename("button"))
    await writeFile(button, `${await readFile(button, "utf8")}\nedited by hand\n`)
    await expect(call("es_design_specs", { check: true })).rejects.toThrow(/button\.md \(differs/)
    await call("es_design_specs", {})

    const notes = designPaths(root).tuiNotes
    await writeFile(notes, "hand written notes\n")
    await expect(call("es_design_specs", { check: true })).rejects.toThrow(/tui-notes\.md \(differs/)
  })

  test("seats are enforced", async () => {
    await expect(call("es_design_specs", {}, "es-programmer")).rejects.toThrow(/designer seat/)
    await expect(call("es_design_harvest", {}, "brainstormer")).rejects.toThrow(/designer seat/)
  })
})
