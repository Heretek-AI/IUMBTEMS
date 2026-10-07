// Queereye on the real host: the designer seat runs the interview through its
// tools, the loop persists incrementally, completion writes the artifacts and
// the drift check re-renders byte-identically.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { designPaths, readTokens, validateTokens } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness, lastAgentRequest } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

const SLOTS: Record<string, string[]> = {
  brand: ["name", "voice", "values"],
  color: ["primary", "neutral", "accent"],
  type: ["family", "scale", "base_size"],
  layout: ["density", "radius", "grid"],
  effects: ["motion", "elevation", "decoration"],
  dark_light: ["modes", "surface"],
  a11y: ["text_level", "large_text_level", "reduced_motion"],
}
const skips = Object.entries(SLOTS)
  .flatMap(([axis, slots]) => slots.map((slot) => call("es_design_skip", { axis, slot })))
  .join(" ")

let state: string
let h: Harness
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-design-host-"))
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

describe("design on the real host", () => {
  test("only the designer seat is advertised the design tools", async () => {
    await h.run("hello")
    const plain = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(plain).not.toContain("es_design_answer")
    await h.run("hello", { agent: "designer" })
    const tools = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(tools).toContain("es_design_status")
    expect(tools).toContain("es_design_answer")
    expect(tools).toContain("es_design_complete")
    expect(tools).toContain("es_design_check")
  })

  test("skip-all → complete → check, with artifacts on disk", async () => {
    const skipped = await h.run(`skip ${skips}`, { agent: "designer" })
    expect(skipped.tools.filter((tool) => tool.status === "error")).toHaveLength(0)

    const completed = await h.run(call("es_design_complete"), { agent: "designer" })
    expect(completed.tools[0]?.status).toBe("completed")
    expect(completed.tools[0]?.text).toContain("reuse ratio")

    const tokens = await readTokens(h.directory)
    expect(validateTokens(tokens)).toEqual([])
    const guide = await Bun.file(designPaths(h.directory).guide).text()
    expect(guide).toContain("# STYLE_GUIDE")
    expect(guide).toContain("One-off raw tokens outside primitive: 0")

    const checked = await h.run(call("es_design_check"), { agent: "designer" })
    expect(checked.tools[0]?.text).toContain("byte-match")
    expect(checked.tools[0]?.text).toContain("One-off mints: 0")
  })

  test("other seats cannot run the interview", async () => {
    const answer = await h.run(call("es_design_answer", { axis: "brand", slot: "name", value: "X" }), {
      agent: "es-programmer",
    })
    expect(answer.tools[0]?.status).toBe("error")
  })
})
