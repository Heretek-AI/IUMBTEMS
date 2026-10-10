// Darkharvest on the real host: the harvester seat plans, scans (local
// sources, fail-closed licences), reads within budget, builds the matrix and
// completes; other seats see none of these tools.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readHarvestResult, readProfile } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness, lastAgentRequest } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

// Real SPDX texts: a permissive verdict needs a full template match.
const fixture = (id: string) =>
  readFileSync(path.resolve(import.meta.dir, "../../core/test/fixtures/licenses", `${id}.txt`), "utf8")
const MIT = fixture("MIT")
const GPL3 = fixture("GPL-3.0-only")

const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

let state: string
let h: Harness
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-harvest-host-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# h\n" },
  })
}, 60_000)

afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("darkharvest on the real host", () => {
  test("only the harvester seat is advertised the teardown tools; callable seats get target and prior art", async () => {
    await h.run("hello")
    const plain = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(plain).not.toContain("es_harvest_plan")
    expect(plain).not.toContain("es_harvest_target")
    await h.run("hello", { agent: "harvester" })
    const tools = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(tools).toContain("es_harvest_plan")
    expect(tools).toContain("es_harvest_scan")
    expect(tools).toContain("es_harvest_matrix")
    expect(tools).toContain("es_harvest_complete")
    expect(tools).toContain("es_harvest_target")
    await h.run("hello", { agent: "grill" })
    const grill = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(grill).toContain("es_harvest_target")
    expect(grill).toContain("es_harvest_prior_art")
    expect(grill).not.toContain("es_harvest_plan")
    await h.run("hello", { agent: "scout" })
    const scout = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(scout).toContain("es_harvest_target")
    expect(scout).not.toContain("es_harvest_prior_art")
  })

  test("the loop enforces licences and writes the report", async () => {
    await write(h.directory, "vendor/LICENSE", MIT)
    await write(h.directory, "vendor/src/a.ts", "export const a = 1\n")
    await write(h.directory, "gpl/LICENSE", GPL3)
    await write(h.directory, "gpl/src/b.ts", "export const b = 2\n")

    const planned = await h.run(
      call("es_harvest_plan", {
        objective: "Take on the widget market",
        candidates: [
          { name: "widget", source: "local:vendor" },
          { name: "gizmo", source: "local:gpl" },
        ],
      }),
      { agent: "harvester" },
    )
    expect(planned.tools[0]?.status).toBe("completed")

    const scanned = await h.run(call("es_harvest_scan", { candidate: "widget" }), { agent: "harvester" })
    expect(scanned.tools[0]?.text).toContain("SPDX:MIT")
    const gplScan = await h.run(call("es_harvest_scan", { candidate: "gizmo" }), { agent: "harvester" })
    expect(gplScan.tools[0]?.text).toContain("NOT authorized")

    const matrix = await h.run(
      call("es_harvest_matrix", {
        rows: [
          { feature: "search", cells: [{ candidate: "widget", verdict: "depend", evidence: "src/a.ts" }] },
          { feature: "sync", cells: [{ candidate: "gizmo", verdict: "vendor" }] },
        ],
      }),
      { agent: "harvester" },
    )
    expect(matrix.tools[0]?.text).toContain("Policy downgrades")

    const completed = await h.run(call("es_harvest_complete"), { agent: "harvester" })
    expect(completed.tools[0]?.status).toBe("completed")
    const result = await readHarvestResult(h.directory)
    expect(result?.profiles).toHaveLength(2)
    expect((await readProfile(h.directory, "gizmo"))?.license).toMatchObject({ spdx: "GPL-3.0", verified: true })
  })

  test("#109: the grill gets a clean-room verdict for a GPL target, as JSON", async () => {
    await write(h.directory, "gpl-target/LICENSE", GPL3)
    await write(h.directory, "gpl-target/src/b.ts", "export const b = 2\n")
    const { tools } = await h.run(
      call("es_harvest_target", { objective: "can we depend on the widget", targets: ["local:gpl-target"] }),
      { agent: "grill" },
    )
    expect(tools[0]?.status).toBe("completed")
    const json = /--- verdicts \(JSON\) ---\n(\[[\s\S]*\])[\s]*$/.exec(tools[0]?.text ?? "")?.[1]
    expect(json).toBeDefined()
    const verdicts = JSON.parse(json!) as Array<{
      target: string
      license: { spdx: string; family: string; verified: boolean }
      verdict: string
      provenance: { origin: string }
    }>
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({
      target: "local:gpl-target",
      license: { spdx: "GPL-3.0", family: "copyleft", verified: true },
      verdict: "clean-room",
    })
    expect(typeof verdicts[0]?.provenance.origin).toBe("string")
  })

  test("the harvester cannot hand-edit engine state or plan outside the project", async () => {
    const before = await Bun.file(path.join(h.directory, ".factory/harvest/runs/default/matrix.json")).text()
    const edit = await h.run(
      `${call("write", { path: ".factory/harvest/runs/default/matrix.json", content: "{}" })} ${call("write", { path: ".factory/harvest/notes/teardown.md", content: "notes" })}`,
      { agent: "harvester" },
    )
    expect(edit.tools[0]?.status).toBe("error")
    expect(edit.tools[1]?.status).toBe("completed")
    expect(await Bun.file(path.join(h.directory, ".factory/harvest/runs/default/matrix.json")).text()).toBe(before)
    const outside = await h.run(
      call("es_harvest_plan", { objective: "x", candidates: [{ name: "s", source: `local:${state}` }], force: true }),
      { agent: "harvester" },
    )
    expect(outside.tools[0]?.status).toBe("error")
    expect(outside.tools[0]?.text).toMatch(/private state|outside the project/)
  })

  test("other seats cannot scan or plan", async () => {
    const scan = await h.run(call("es_harvest_scan", { candidate: "widget" }), { agent: "brainstormer" })
    expect(scan.tools[0]?.status).toBe("error")
    const plan = await h.run(call("es_harvest_plan", { objective: "x", candidates: [] }), { agent: "es-programmer" })
    expect(plan.tools[0]?.status).toBe("error")
  })
})
