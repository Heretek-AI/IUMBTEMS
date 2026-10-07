// Darkharvest on the real host: the harvester seat plans, scans (local
// sources, fail-closed licences), reads within budget, builds the matrix and
// completes; other seats see none of these tools.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readHarvestResult, readProfile } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness, lastAgentRequest } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

const MIT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction. The software is provided "as is".`

const GPL3 = `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
Copyright (C) 2007 Free Software Foundation, Inc.`

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
  test("only the harvester seat is advertised the harvest tools", async () => {
    await h.run("hello")
    const plain = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(plain).not.toContain("es_harvest_plan")
    await h.run("hello", { agent: "harvester" })
    const tools = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(tools).toContain("es_harvest_plan")
    expect(tools).toContain("es_harvest_scan")
    expect(tools).toContain("es_harvest_matrix")
    expect(tools).toContain("es_harvest_complete")
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

  test("other seats cannot scan or plan", async () => {
    const scan = await h.run(call("es_harvest_scan", { candidate: "widget" }), { agent: "brainstormer" })
    expect(scan.tools[0]?.status).toBe("error")
    const plan = await h.run(call("es_harvest_plan", { objective: "x", candidates: [] }), { agent: "es-programmer" })
    expect(plan.tools[0]?.status).toBe("error")
  })
})
