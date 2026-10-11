// Issue #192 (Darkharvest) integration tests — core side.
//
// - Harvester targeting a path outside the project is refused, with an
//   in-project control showing allowed paths still work.
// - An Apache-header-only fixture (no LICENSE file) stays clean-room. The
//   returned literal is recorded as-is: `Apache-2.0`, unverified
//   (bug #264 observed the claim wording "unknown"; the enforced property —
//   clean-room — holds, so this asserts current behavior, not the old word).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildMatrix,
  checkVerdict,
  DEFAULT_LICENSE_WHITELIST,
  detectLicense,
  harvestTools,
  scanSource,
} from "../src/index.ts"

const dirs: string[] = []
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const write = async (root: string, file: string, content: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

const MIT_LICENSE = `MIT License

Copyright (c) 2026 Test

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

describe("issue #192: out-of-project harvest is refused", () => {
  test("plan, target and scan refuse an outside path; an in-project path works", async () => {
    const root = await tmp("es-192-root-")
    const outside = await tmp("es-192-outside-")
    await write(outside, "key.txt", "SIGNING-KEY-DO-NOT-READ")

    const tools = harvestTools({ root })
    const plan = tools.find((tool) => tool.name === "es_harvest_plan")!
    const target = tools.find((tool) => tool.name === "es_harvest_target")!

    // Refused: a harvester plan that points outside the project.
    await expect(
      plan.execute(
        { objective: "x", candidates: [{ name: "evil", source: `local:${outside}` }], force: true },
        { agent: "harvester" },
      ),
    ).rejects.toThrow(/outside the project/)
    // Refused: the callable verdict check, same seat, same outside path.
    await expect(
      target.execute({ objective: "x", targets: [`local:${outside}`] }, { agent: "harvester" }),
    ).rejects.toThrow(/outside the project/)
    // Refused at the scan layer too (no bytes are read: the throw precedes I/O).
    await expect(scanSource(root, "evil", { kind: "local", path: outside }, { regexOnly: true })).rejects.toThrow(
      /outside the project/,
    )

    // Control: an in-project candidate plans and scans fine.
    await write(root, "ok/LICENSE", MIT_LICENSE)
    await write(root, "ok/src/a.ts", "export const a = 1\n")
    const planned = await plan.execute(
      { objective: "x", candidates: [{ name: "ok", source: "local:ok" }], force: true },
      { agent: "harvester" },
    )
    expect(planned).toContain("ok")
    const profile = await scanSource(root, "ok", { kind: "local", path: "ok" }, { regexOnly: true })
    expect(profile.license).toMatchObject({ spdx: "MIT", verified: true, source: "license-file" })
  })
})

describe("issue #192: Apache-header-only fixture is clean-room", () => {
  // No LICENSE file anywhere in this fixture: one source file carries only
  // `SPDX-License-Identifier: Apache-2.0`.
  const setupHeaderOnly = async (root: string, dir = "header-only") => {
    await write(root, `${dir}/src/a.ts`, "// SPDX-License-Identifier: Apache-2.0\nexport const a = 1\n")
  }

  test("detectLicense literal is Apache-2.0, unverified (bug #264); policy forces clean-room", async () => {
    const root = await tmp("es-192-apache-")
    await setupHeaderOnly(root)
    const dir = path.join(root, "header-only")

    const finding = await detectLicense(dir)
    // Pinned literal: bug #264 notes the claim said "unknown" here, but the
    // code returns the header id unverified. Assert current behavior so any
    // change to the literal is a visible diff; the safety property below is
    // what must never regress.
    expect(finding.spdx).toBe("Apache-2.0")
    expect(finding).toMatchObject({ source: "spdx-header", verified: false, family: "permissive" })

    // Fail-closed: an unverified header can never authorize depend/vendor.
    for (const proposed of ["depend", "vendor"] as const) {
      const checked = checkVerdict(proposed, finding, DEFAULT_LICENSE_WHITELIST)
      expect(checked.verdict).toBe("clean-room")
      expect(checked.downgraded).toMatch(/unverified/)
      // Dangerous misclassification guard: unknown/copyleft/unverified must
      // never come back depend/vendor-able. This would be a FINDING, not a fix.
      expect(checked.verdict).not.toBe("depend")
      expect(checked.verdict).not.toBe("vendor")
    }
  })

  test("scan → matrix downgrades a proposed depend to clean-room", async () => {
    const root = await tmp("es-192-apache-flow-")
    await setupHeaderOnly(root)
    const tools = harvestTools({ root })
    const call = (name: string, input: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.execute(input, { agent: "harvester" })

    await call("es_harvest_plan", {
      objective: "vet the header-only lib",
      candidates: [{ name: "header-only", source: "local:header-only" }],
    })
    const scanned = await call("es_harvest_scan", { candidate: "header-only" })
    expect(scanned).toContain("Apache-2.0")
    expect(scanned).toContain("UNVERIFIED")

    const matrixText = await call("es_harvest_matrix", {
      rows: [{ feature: "widget", cells: [{ candidate: "header-only", verdict: "depend" }] }],
    })
    expect(matrixText).toContain("clean-room")

    const profiles = new Map([
      [
        "header-only",
        {
          version: 1 as const,
          id: "header-only",
          name: "header-only",
          license: await detectLicense(path.join(root, "header-only")),
          languages: {},
          dependencies: { runtime: [], dev: [] },
          size: { files: 0, bytes: 0, tokens: 0 },
          graph: { internalEdges: 0, external: 0, parsers: { treeSitter: 0, regex: 0 } },
          provenance: {},
          warnings: [],
          scannedAt: new Date().toISOString(),
        },
      ],
    ])
    const built = buildMatrix(
      ["header-only"],
      profiles,
      [{ feature: "widget", cells: [{ candidate: "header-only", verdict: "depend" }] }],
      DEFAULT_LICENSE_WHITELIST,
    )
    expect(built.matrix.rows[0]?.cells[0]?.verdict).toBe("clean-room")
    expect(built.matrix.rows[0]?.cells[0]?.downgraded).toMatch(/unverified/)
    expect(built.downgrades).toHaveLength(1)
  })

  test("es_harvest_target reports clean-room with the same literal", async () => {
    const root = await tmp("es-192-apache-target-")
    await setupHeaderOnly(root)
    const target = harvestTools({ root }).find((tool) => tool.name === "es_harvest_target")!
    const text = await target.execute(
      { objective: "can we depend on it", targets: ["local:header-only"] },
      { agent: "grill" },
    )
    const json = /--- verdicts \(JSON\) ---\n(\[[\s\S]*\])[\s]*$/.exec(text)?.[1]
    expect(json).toBeDefined()
    const verdicts = JSON.parse(json!) as Array<{
      target: string
      license: { spdx: string; family: string; verified: boolean }
      verdict: string
    }>
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]?.license).toMatchObject({ spdx: "Apache-2.0", verified: false })
    expect(verdicts[0]?.verdict).toBe("clean-room")
  })
})
