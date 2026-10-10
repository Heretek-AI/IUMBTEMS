// Issue #193: the /design interview on the real testkit host with scripted
// answers. The designer seat walks the 7-axis interview through its tools
// (repairs included), completion writes DTCG tokens that validate with zero
// one-offs, and a failing-contrast palette is refused by the gate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  compileToCssVars,
  designPaths,
  findOneOffs,
  gatePairs,
  probeReport,
  readProbes,
  readTokens,
  renderGuide,
  validatePair,
  validateTokens,
  writeArtifacts,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const answer = (axis: string, slot: string, value: string) => call("es_design_answer", { axis, slot, value })

// Scripted answers: real words through every slot (not skip-all — that path
// is design.test.ts). All values are repair-safe (recommended words only).
const SCRIPTED: Array<[string, string, string]> = [
  ["brand", "name", "Acme"],
  ["brand", "voice", "minimal"],
  ["brand", "values", "clarity"],
  ["color", "primary", "ocean"],
  ["color", "neutral", "slate"],
  ["color", "accent", "teal"],
  ["type", "family", "system"],
  ["type", "scale", "1.250"],
  ["type", "base_size", "16"],
  ["layout", "density", "comfortable"],
  ["layout", "radius", "soft"],
  ["layout", "grid", "12"],
  ["effects", "motion", "subtle"],
  ["effects", "elevation", "restrained"],
  ["effects", "decoration", "text-safe-only"],
  ["dark_light", "modes", "both"],
  ["dark_light", "surface", "dimmed brand"],
  ["a11y", "text_level", "AA"],
  ["a11y", "large_text_level", "AA-large"],
  ["a11y", "reduced_motion", "yes"],
]

let state: string
let h: Harness
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-design-interview-host-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# d\n" },
  })
}, 60_000)

afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("design interview with scripted answers", () => {
  test("vague and smuggled answers are repaired, scripted answers settle every slot", async () => {
    const status = await h.run(call("es_design_status"), { agent: "designer" })
    expect(status.tools[0]?.text).toContain("slots settled")

    const vague = await h.run(answer("brand", "voice", "whatever"), { agent: "designer" })
    expect(vague.tools[0]?.text).toContain("Not accepted (vague)")

    const smuggled = await h.run(answer("color", "primary", "#ff0000"), { agent: "designer" })
    expect(smuggled.tools[0]?.text).toContain("Not accepted (smuggled)")

    const answered = await h.run(SCRIPTED.map(([axis, slot, value]) => answer(axis, slot, value)).join(" "), {
      agent: "designer",
    })
    expect(answered.tools.filter((tool) => tool.status === "error")).toHaveLength(0)
    expect(answered.tools).toHaveLength(SCRIPTED.length)
    for (const tool of answered.tools) expect(tool.text).toContain("Accepted")
    expect(answered.tools[answered.tools.length - 1]?.text).toContain("run es_design_complete")
  })

  test("completion writes DTCG tokens that validate with zero one-offs", async () => {
    const completed = await h.run(call("es_design_complete"), { agent: "designer" })
    expect(completed.tools[0]?.status).toBe("completed")
    expect(completed.tools[0]?.text).toContain("reuse ratio")

    const tokens = await readTokens(h.directory)
    expect(validateTokens(tokens)).toEqual([])
    expect(findOneOffs(tokens)).toEqual([])

    const probes = await readProbes(h.directory)
    expect(probes!.length).toBeGreaterThan(0)
    expect(probes!.every((row) => row.pass)).toBe(true)

    const guide = await Bun.file(designPaths(h.directory).guide).text()
    expect(guide).toContain("# STYLE_GUIDE")

    const checked = await h.run(call("es_design_check"), { agent: "designer" })
    expect(checked.tools[0]?.text).toContain("byte-match")
    expect(checked.tools[0]?.text).toContain("One-off mints: 0")
  })

  test("a failing-contrast palette is refused by the gate", async () => {
    // The completion tool derives its probes from the ratio-first generator,
    // so the interview's own palette always passes; refusal is pinned at the
    // gate the completion tool enforces (es_design_complete: "Contrast gate
    // failed") and surfaced through es_design_check's pair count.
    const failing = gatePairs([{ name: "washed body", fg: "#eeeeee", bg: "#ffffff" }])
    expect(failing).toHaveLength(1)
    expect(failing[0]!.errors.join("; ")).toContain("below AA body text minimum 4.5:1")
    expect(validatePair("#eeeeee", "#ffffff", { decorative: true }).errors).toContain(
      "decorative exemption refused for a text pair",
    )
    // Control: a passing pair is green.
    expect(validatePair("#595959", "#ffffff").errors).toEqual([])

    // Host-level: plant a failing probe row (with its guide re-render) and
    // the check surfaces the failure instead of passing silently.
    const tokens = await readTokens(h.directory)
    const bad = probeReport([{ name: "washed body", fg: "#eeeeee", bg: "#ffffff" }])
    expect(bad[0]?.pass).toBe(false)
    await writeArtifacts(h.directory, {
      tokens,
      probes: bad,
      guide: renderGuide(tokens, bad),
      css: compileToCssVars(tokens),
    })
    const surfaced = await h.run(call("es_design_check"), { agent: "designer" })
    expect(surfaced.tools[0]?.text).toContain("Contrast pairs: 0/1 pass")
  })
})
