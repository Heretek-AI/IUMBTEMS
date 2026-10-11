// Issue #192 (Darkharvest) integration tests — real host via packages/testkit.
//
// - The harvester seat targeting a path outside the project is refused, with
//   an in-project control showing allowed paths still work.
// - An Apache-header-only fixture (no LICENSE file) stays clean-room. The
//   returned literal is pinned as `Apache-2.0`, unverified (bug #264: the
//   claim wording said "unknown"; the enforced clean-room property holds, so
//   this asserts current behavior and reports the literal).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readProfile } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

const fixture = (id: string) =>
  readFileSync(path.resolve(import.meta.dir, "../../core/test/fixtures/licenses", `${id}.txt`), "utf8")
const MIT = fixture("MIT")

const write = async (root: string, file: string, content: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

let state: string
let h: Harness
const outsideDirs: string[] = []
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-192-host-state-"))
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
  for (const dir of outsideDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("issue #192 on the real host: out-of-project harvest is refused", () => {
  test("harvester plan and target refuse an outside path; an in-project path works", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "es-192-outside-"))
    outsideDirs.push(outside)
    await write(outside, "key.txt", "SIGNING-KEY-DO-NOT-READ")

    // Refused: plan with a candidate outside the project.
    const refused = await h.run(
      call("es_harvest_plan", {
        objective: "take the outside",
        run: "o192-outside",
        candidates: [{ name: "sneaky", source: `local:${outside}` }],
        force: true,
      }),
      { agent: "harvester" },
    )
    expect(refused.tools[0]?.status).toBe("error")
    expect(refused.tools[0]?.text).toMatch(/outside the project/)

    // Refused: the callable verdict check, same outside path, same seat.
    const targetRefused = await h.run(
      call("es_harvest_target", {
        objective: "can we depend on the outside",
        targets: [`local:${outside}`],
        run: "o192-outside-target",
      }),
      { agent: "harvester" },
    )
    expect(targetRefused.tools[0]?.status).toBe("error")
    expect(targetRefused.tools[0]?.text).toMatch(/outside the project/)

    // Control: an in-project candidate is still allowed (plan, scan, target).
    await write(h.directory, "o192-ok/LICENSE", MIT)
    await write(h.directory, "o192-ok/src/a.ts", "export const a = 1\n")
    const planned = await h.run(
      call("es_harvest_plan", {
        objective: "take the inside",
        run: "o192-control",
        candidates: [{ name: "ok", source: "local:o192-ok" }],
        force: true,
      }),
      { agent: "harvester" },
    )
    expect(planned.tools[0]?.status).toBe("completed")
    const scanned = await h.run(call("es_harvest_scan", { candidate: "ok", run: "o192-control" }), {
      agent: "harvester",
    })
    expect(scanned.tools[0]?.status).toBe("completed")
    expect(scanned.tools[0]?.text).toContain("SPDX:MIT")
    const verdict = await h.run(
      call("es_harvest_target", {
        objective: "can we depend on the inside",
        targets: ["local:o192-ok"],
        run: "o192-control-target",
      }),
      { agent: "grill" },
    )
    expect(verdict.tools[0]?.status).toBe("completed")
    expect(verdict.tools[0]?.text).toContain("→ depend")
  })
})

describe("issue #192 on the real host: Apache-header-only fixture is clean-room", () => {
  test("scan and matrix keep an Apache header (no LICENSE) clean-room; literal is Apache-2.0 unverified", async () => {
    // No LICENSE file: one source file declares only an SPDX header.
    await write(h.directory, "o192-apache/src/a.ts", "// SPDX-License-Identifier: Apache-2.0\nexport const a = 1\n")

    const planned = await h.run(
      call("es_harvest_plan", {
        objective: "vet the header-only lib",
        run: "o192-apache",
        candidates: [{ name: "apache-header", source: "local:o192-apache" }],
        force: true,
      }),
      { agent: "harvester" },
    )
    expect(planned.tools[0]?.status).toBe("completed")

    const scanned = await h.run(call("es_harvest_scan", { candidate: "apache-header", run: "o192-apache" }), {
      agent: "harvester",
    })
    expect(scanned.tools[0]?.status).toBe("completed")
    expect(scanned.tools[0]?.text).toContain("Apache-2.0")
    expect(scanned.tools[0]?.text).toContain("UNVERIFIED")
    expect(scanned.tools[0]?.text).toContain("NOT authorized")

    // Pinned literal (bug #264): the header id is reported unverified rather
    // than "unknown". The verdict below is the property that must not regress.
    const profile = await readProfile(h.directory, "apache-header", "o192-apache")
    expect(profile?.license).toMatchObject({ spdx: "Apache-2.0", verified: false, source: "spdx-header" })

    const matrix = await h.run(
      call("es_harvest_matrix", {
        run: "o192-apache",
        rows: [{ feature: "widget", cells: [{ candidate: "apache-header", verdict: "depend" }] }],
      }),
      { agent: "harvester" },
    )
    expect(matrix.tools[0]?.status).toBe("completed")
    expect(matrix.tools[0]?.text).toContain("clean-room")
    // Dangerous misclassification guard: a proposed depend on an unverified
    // header must never survive as depend/vendor.
    expect(matrix.tools[0]?.text).not.toMatch(/Verdicts: depend 1/)
  })

  test("es_harvest_target reports clean-room with the same literal", async () => {
    const { tools } = await h.run(
      call("es_harvest_target", {
        objective: "can we depend on the header-only lib",
        targets: ["local:o192-apache"],
        run: "o192-apache-target",
      }),
      { agent: "grill" },
    )
    expect(tools[0]?.status).toBe("completed")
    const json = /--- verdicts \(JSON\) ---\n(\[[\s\S]*\])[\s]*$/.exec(tools[0]?.text ?? "")?.[1]
    expect(json).toBeDefined()
    const verdicts = JSON.parse(json!) as Array<{
      target: string
      license: { spdx: string; family: string; verified: boolean }
      verdict: string
    }>
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({
      target: "local:o192-apache",
      license: { spdx: "Apache-2.0", verified: false },
      verdict: "clean-room",
    })
    expect(verdicts[0]?.verdict).not.toBe("depend")
    expect(verdicts[0]?.verdict).not.toBe("vendor")
  })
})
