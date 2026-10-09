// Darkharvest: deterministic SPDX detection, sources (local/git/registry/API),
// profiles with provenance, the token-budgeted reader, the fail-closed licence
// policy and the tool loop that writes the report, vendor plan and clean-room
// specs.
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { HarvestProfile, LicenseFinding } from "../src/index.ts"
import {
  buildMatrix,
  checkVerdict,
  DEFAULT_LICENSE_WHITELIST,
  detectLicense,
  githubApi,
  harvestPaths,
  harvestTools,
  identifyLicenseText,
  parseSource,
  readCandidate,
  readHarvestResult,
  readMatrix,
  readProfile,
  registryMetadata,
  scanSource,
} from "../src/index.ts"
import { gitRepo } from "./helpers.ts"

// Real SPDX license-list texts (v3.29.0); see fixtures/licenses.
const fixture = (id: string) => readFileSync(path.join(import.meta.dir, "fixtures/licenses", `${id}.txt`), "utf8")
const MIT = fixture("MIT")
const ISC = fixture("ISC")
const GPL3 = fixture("GPL-3.0-only")

const dirs: string[] = []
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

const profileFor = (license: LicenseFinding, id = "p"): HarvestProfile => ({
  version: 1,
  id,
  name: id,
  license,
  languages: {},
  dependencies: { runtime: [], dev: [] },
  size: { files: 0, bytes: 0, tokens: 0 },
  graph: { internalEdges: 0, external: 0, parsers: { treeSitter: 0, regex: 0 } },
  provenance: {},
  warnings: [],
  scannedAt: new Date().toISOString(),
})

describe("SPDX detection", () => {
  test.each([
    ["MIT", "MIT", "permissive", true],
    ["ISC", "ISC", "permissive", true],
    ["BSD-2-Clause", "BSD-2-Clause", "permissive", true],
    ["BSD-3-Clause", "BSD-3-Clause", "permissive", true],
    ["Apache-2.0", "Apache-2.0", "permissive", true],
    ["0BSD", "0BSD", "permissive", true],
    ["Unlicense", "Unlicense", "public-domain", true],
    ["CC0-1.0", "CC0-1.0", "public-domain", true],
    ["GPL-2.0-only", "GPL-2.0", "copyleft", true],
    ["GPL-3.0-only", "GPL-3.0", "copyleft", true],
    ["LGPL-2.1-only", "LGPL-2.1", "weak-copyleft", true],
    ["LGPL-3.0-only", "LGPL-3.0", "weak-copyleft", true],
    ["AGPL-3.0-only", "AGPL-3.0", "copyleft", true],
    ["MPL-2.0", "MPL-2.0", "weak-copyleft", true],
    ["SSPL-1.0", "SSPL-1.0", "copyleft", true],
    // Look-alikes and source-available licences never verify as permissive.
    ["JSON", "unknown", "unknown", false],
    ["MIT-0", "unknown", "unknown", false],
    ["X11", "unknown", "unknown", false],
    ["BSD-4-Clause", "BSD-4-Clause", "permissive", false],
    ["BUSL-1.1", "BUSL-1.1", "unknown", false],
    ["Elastic-2.0", "Elastic-2.0", "unknown", false],
  ])("%s text → %s (%s, verified %p)", (file, spdx, family, verified) => {
    expect(identifyLicenseText(fixture(file))).toMatchObject({ spdx, family, verified })
  })

  test("riders, edits and real-world framing", () => {
    const body = MIT.replace(/^MIT License\n\nCopyright[^\n]*\n/, "")
    // Common framing still matches: a different title, several copyright lines, an HTML comment.
    expect(
      identifyLicenseText(
        `<!-- generated -->\nThe MIT License (MIT)\n\nCopyright (c) 2026 A\nCopyright 2025 B. All rights reserved.\n${body}`,
      )?.spdx,
    ).toBe("MIT")
    expect(identifyLicenseText(`(MIT)\n\nCopyright (c) 2013 J &lt;j@x&gt;\n${body}`)?.spdx).toBe("MIT")
    // Riders, appended or prepended, and edited terms do not.
    const commons = `"Commons Clause" License Condition v1.0\n\nThe Software is provided to you by the Licensor under the License, as defined below, subject to the following condition. Without limiting other conditions in the License, the grant of rights under the License will not include, and the License does not grant to you, the right to Sell the Software.\n`
    expect(identifyLicenseText(`${MIT}\n${commons}`)).toMatchObject({
      spdx: "LicenseRef-Commons-Clause",
      verified: false,
    })
    expect(identifyLicenseText(`${commons}\n${MIT}`)).toMatchObject({
      spdx: "LicenseRef-Commons-Clause",
      verified: false,
    })
    expect(identifyLicenseText(`${MIT}\nThe Software shall be used for Good, not Evil.`)?.spdx).toBe("unknown")
    expect(identifyLicenseText(MIT.replace("without restriction", "with restrictions"))?.spdx).toBe("unknown")
    expect(identifyLicenseText("All rights reserved. Do what you like.")).toBeUndefined()
  })

  test("every licence file counts; the most restrictive wins; permissive ones combine", async () => {
    const dual = await tmp("es-spdx-dual-")
    await write(dual, "LICENSE-MIT", MIT)
    await write(dual, "LICENSE-APACHE", fixture("Apache-2.0"))
    expect(await detectLicense(dual)).toMatchObject({
      spdx: "Apache-2.0 AND MIT",
      family: "permissive",
      verified: true,
    })

    const mixed = await tmp("es-spdx-mixed-")
    await write(mixed, "LICENSE", MIT)
    await write(mixed, "COPYING", GPL3)
    expect(await detectLicense(mixed)).toMatchObject({ spdx: "GPL-3.0", family: "copyleft" })

    const notices = await tmp("es-spdx-notices-")
    await write(notices, "LICENSE", MIT)
    await write(notices, "LICENSE-THIRD-PARTY.md", "Portions are licensed by their owners; see each file.")
    expect(await detectLicense(notices)).toMatchObject({ spdx: "unknown", verified: false })

    // A GPL header in one source file makes an MIT project copyleft.
    const header = await tmp("es-spdx-header-")
    await write(header, "LICENSE", MIT)
    await write(header, "src/vendored.c", "/* SPDX-License-Identifier: GPL-2.0-only */\nint x;\n")
    await write(header, "src/page.html.ts", "// <!-- SPDX-License-Identifier: MIT -->\nexport {}\n")
    const withHeader = await detectLicense(header)
    expect(withHeader).toMatchObject({ spdx: "GPL-2.0 AND MIT", family: "copyleft" })
    expect(withHeader.note).toContain("GPL-2.0")
  })

  test("a LICENSE file beats everything; headers and manifests never verify", async () => {
    const root = await tmp("es-spdx-")
    await write(root, "LICENSE", MIT)
    await write(root, "package.json", JSON.stringify({ license: "GPL-3.0" }))
    const fromFile = await detectLicense(root)
    expect(fromFile).toMatchObject({ spdx: "MIT", source: "license-file", verified: true, confidence: "high" })
    expect(fromFile.sha256).toMatch(/^[0-9a-f]{64}$/)

    await rm(path.join(root, "LICENSE"))
    await write(root, "src/a.ts", "// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception\nexport const x = 1\n")
    const fromHeader = await detectLicense(root)
    expect(fromHeader).toMatchObject({ spdx: "Apache-2.0", source: "spdx-header", verified: false })
    expect(fromHeader.file).toBe("src/a.ts")

    await rm(path.join(root, "src/a.ts"))
    const fromManifest = await detectLicense(root)
    expect(fromManifest).toMatchObject({ spdx: "GPL-3.0", source: "manifest", verified: false })

    await write(root, "package.json", "{}")
    const unknown = await detectLicense(root)
    expect(unknown).toMatchObject({ spdx: "unknown", verified: false })
  })
})

describe("sources", () => {
  test("source specs parse to typed sources", () => {
    expect(parseSource("github:owner/repo")).toEqual({ kind: "github", repo: "owner/repo" })
    expect(parseSource("gitlab:group/project")).toEqual({ kind: "gitlab", repo: "group/project" })
    expect(parseSource("npm:left-pad")).toEqual({ kind: "registry", registry: "npm", name: "left-pad" })
    expect(parseSource("https://example.com/x.git")).toEqual({ kind: "git", url: "https://example.com/x.git" })
    expect(parseSource("./vendor")).toEqual({ kind: "local", path: "./vendor" })
  })

  test("the GitHub client maps search results and fails loudly", async () => {
    const fetch = (async (url: string) => {
      expect(String(url)).toContain("search/repositories")
      return Response.json({
        items: [
          {
            full_name: "acme/widget",
            name: "widget",
            html_url: "https://github.com/acme/widget",
            description: "a widget",
            stargazers_count: 120,
            pushed_at: "2026-01-02T03:04:05Z",
            license: { spdx_id: "MIT" },
            topics: ["tools"],
          },
        ],
      })
    }) as unknown as typeof globalThis.fetch
    const [repo] = await githubApi({ fetch }).search("widget")
    expect(repo).toMatchObject({ fullName: "acme/widget", stars: 120, license: "MIT" })
    const failing = (async () => new Response("nope", { status: 403 })) as unknown as typeof globalThis.fetch
    await expect(githubApi({ fetch: failing }).search("x")).rejects.toThrow(/HTTP 403/)
  })

  test("registry metadata is self-reported only", async () => {
    const fetch = (async () =>
      Response.json({
        "dist-tags": { latest: "1.2.3" },
        versions: { "1.2.3": { license: "MIT" } },
        description: "pads",
      })) as unknown as typeof globalThis.fetch
    const pkg = await registryMetadata("npm", "left-pad", { fetch })
    expect(pkg).toMatchObject({ registry: "npm", name: "left-pad", version: "1.2.3", license: "MIT" })
    const pypi = (async () =>
      Response.json({
        info: {
          name: "requests",
          version: "2.0.0",
          classifiers: ["License :: OSI Approved :: Apache Software License"],
        },
      })) as unknown as typeof globalThis.fetch
    expect(await registryMetadata("pypi", "requests", { fetch: pypi })).toMatchObject({ license: "Apache-2.0" })
  })
})

describe("scanning and provenance", () => {
  test("a local project scans into a profile with per-field provenance", async () => {
    const fx = await gitRepo("es-harvest-")
    dirs.push(fx.root)
    await write(fx.root, "LICENSE", MIT)
    await write(fx.root, "package.json", JSON.stringify({ name: "widget", dependencies: { zod: "4" } }))
    await write(fx.root, "src/a.ts", 'import { b } from "./b"\nexport const a = b\n')
    await write(fx.root, "src/b.ts", "export const b = 1\n")
    const profile = await scanSource(fx.root, "widget", { kind: "local", path: "." }, { regexOnly: true })
    expect(profile.license).toMatchObject({ spdx: "MIT", verified: true, source: "license-file" })
    expect(profile.name).toBe("widget")
    expect(profile.dependencies.runtime).toEqual(["zod"])
    expect(profile.size.files).toBe(2)
    expect(profile.graph.internalEdges).toBe(1)
    expect(profile.commit).toBe((await gitRepoCommit(fx.root)).slice(0, 40))
    expect(profile.provenance.license?.verified).toBe(true)
    expect(profile.provenance.origin).toMatchObject({ kind: "local", verified: true })
    await fx.cleanup()
  })

  test("a shallow git clone scans too", async () => {
    const source = await gitRepo("es-harvest-origin-")
    dirs.push(source.root)
    await write(source.root, "LICENSE", ISC)
    await write(source.root, "src/x.py", "def x():\n    return 1\n")
    await commitAll(source.root)
    const root = await tmp("es-harvest-work-")
    const profile = await scanSource(
      root,
      "origin",
      { kind: "git", url: source.root },
      { regexOnly: true, allowOutside: true },
    )
    expect(profile.license.spdx).toBe("ISC")
    expect(profile.size.files).toBe(1)
    await source.cleanup()
  })

  test("a registry scan is flagged unverified", async () => {
    const root = await tmp("es-harvest-reg-")
    const fetch = (async () =>
      Response.json({
        "dist-tags": { latest: "9.9.9" },
        versions: { "9.9.9": { license: "MIT" } },
      })) as unknown as typeof globalThis.fetch
    const profile = await scanSource(
      root,
      "left-pad",
      { kind: "registry", registry: "npm", name: "left-pad" },
      { fetch },
    )
    expect(profile.license).toMatchObject({ spdx: "MIT", source: "registry", verified: false })
    expect(profile.warnings.join(" ")).toContain("self-reported")
    expect(profile.provenance.license?.verified).toBe(false)
  })

  test("the read budget is enforced and paths cannot escape the candidate", async () => {
    const root = await tmp("es-harvest-read-")
    await write(root, "vendor/a.txt", "x".repeat(2_000))
    await scanSource(root, "vendor", { kind: "local", path: "vendor" }, { regexOnly: true })
    const first = await readCandidate(root, "vendor", "a.txt", { budgetTokens: 100 })
    expect(first.truncated).toBe(true)
    expect(first.text.length).toBe(400)
    expect(first.spent).toBe(100)
    await expect(readCandidate(root, "vendor", "a.txt", { budgetTokens: 100 })).rejects.toThrow(/budget .* exhausted/)
    await expect(readCandidate(root, "vendor", "../outside.txt", { budgetTokens: 100 })).rejects.toThrow(/outside/)
  })
})

describe("the fail-closed licence policy", () => {
  const license = (overrides: Partial<LicenseFinding>): LicenseFinding => ({
    spdx: "MIT",
    family: "permissive",
    source: "license-file",
    verified: true,
    confidence: "high",
    file: "LICENSE",
    sha256: "a".repeat(64),
    ...overrides,
  })

  test("depend/vendor need a verified, whitelisted permissive licence", () => {
    expect(checkVerdict("depend", license({}), DEFAULT_LICENSE_WHITELIST)).toMatchObject({
      verdict: "depend",
      attribution: expect.stringContaining("SPDX:MIT"),
    })
    expect(
      checkVerdict("depend", license({ spdx: "GPL-3.0", family: "copyleft" }), DEFAULT_LICENSE_WHITELIST),
    ).toMatchObject({ verdict: "clean-room", downgraded: expect.stringContaining("copyleft") })
    expect(
      checkVerdict("vendor", license({ verified: false, source: "manifest" }), DEFAULT_LICENSE_WHITELIST),
    ).toMatchObject({ verdict: "clean-room", downgraded: expect.stringContaining("unverified") })
    expect(
      checkVerdict("depend", license({ spdx: "Zlib", family: "unknown" }), DEFAULT_LICENSE_WHITELIST),
    ).toMatchObject({
      verdict: "clean-room",
    })
    expect(
      checkVerdict("depend", license({ spdx: "Zlib", family: "permissive" }), DEFAULT_LICENSE_WHITELIST).downgraded,
    ).toContain("whitelist")
    expect(checkVerdict("skip", license({}), DEFAULT_LICENSE_WHITELIST).verdict).toBe("skip")
    expect(checkVerdict("clean-room", license({}), DEFAULT_LICENSE_WHITELIST).verdict).toBe("clean-room")
  })

  test("buildMatrix applies the policy and records downgrades", () => {
    const profiles = new Map([
      ["mit", profileFor(license({}), "mit")],
      ["gpl", profileFor(license({ spdx: "GPL-3.0", family: "copyleft" }), "gpl")],
    ])
    const built = buildMatrix(
      ["mit", "gpl"],
      profiles,
      [
        {
          feature: "auth",
          cells: [
            { candidate: "mit", verdict: "depend", evidence: "src/auth.ts" },
            { candidate: "gpl", verdict: "vendor" },
          ],
        },
      ],
      DEFAULT_LICENSE_WHITELIST,
    )
    const [mit, gpl] = built.matrix.rows[0]!.cells
    expect(mit).toMatchObject({ verdict: "depend", attribution: expect.stringContaining("SPDX:MIT") })
    expect(gpl).toMatchObject({ verdict: "clean-room", downgraded: expect.stringContaining("copyleft") })
    expect(built.downgrades).toHaveLength(1)
  })
})

describe("the tool loop", () => {
  const tools = (root: string) => harvestTools({ root })
  const call = (root: string, name: string, input: Record<string, unknown>, agent: string) =>
    tools(root)
      .find((tool) => tool.name === name)!
      .execute(input, { agent })

  test("seats are enforced", async () => {
    const root = await tmp("es-harvest-seat-")
    await expect(call(root, "es_harvest_plan", { objective: "x", candidates: [] }, "es-programmer")).rejects.toThrow(
      /harvester seat/,
    )
    await expect(call(root, "es_harvest_scan", { candidate: "x" }, "brainstormer")).rejects.toThrow(/harvester seat/)
  })

  test("plan → scan → matrix → complete writes the report, vendor plan and clean-room specs", async () => {
    const root = await tmp("es-harvest-flow-")
    await write(root, "vendor/LICENSE", MIT)
    await write(root, "vendor/package.json", JSON.stringify({ name: "widget" }))
    await write(root, "vendor/src/a.ts", "export const a = 1\n")
    await write(root, "gpl/LICENSE", GPL3)
    await write(root, "gpl/src/b.ts", "export const b = 2\n")

    const planned = await call(
      root,
      "es_harvest_plan",
      {
        objective: "Take on the widget market",
        candidates: [
          { name: "widget", source: "local:vendor" },
          { name: "gizmo", source: "local:gpl" },
        ],
      },
      "harvester",
    )
    expect(planned).toContain("widget")

    const scanned = await call(root, "es_harvest_scan", { candidate: "widget" }, "harvester")
    expect(scanned).toContain("depend/vendor: authorized with SPDX:MIT")
    const gpl = await call(root, "es_harvest_scan", { candidate: "gizmo" }, "harvester")
    expect(gpl).toContain("NOT authorized")
    expect(gpl).toContain("copyleft")

    const read = await call(root, "es_harvest_read", { candidate: "widget", file: "src/a.ts" }, "harvester")
    expect(read).toContain("export const a = 1")
    expect(read).toMatch(/tokens read/)

    const matrix = await call(
      root,
      "es_harvest_matrix",
      {
        rows: [
          { feature: "instant search", cells: [{ candidate: "widget", verdict: "depend", evidence: "src/a.ts" }] },
          { feature: "sync engine", cells: [{ candidate: "gizmo", verdict: "vendor", evidence: "src/b.ts" }] },
        ],
      },
      "harvester",
    )
    expect(matrix).toContain("Policy downgrades")
    expect(matrix).toContain("clean-room")

    const completed = await call(root, "es_harvest_complete", {}, "harvester")
    expect(completed).toContain("VENDOR-PLAN.md")
    const result = await readHarvestResult(root)
    expect(result?.profiles).toHaveLength(2)
    expect(result?.matrix.rows).toHaveLength(2)
    expect(await Bun.file(harvestPaths(root).report).text()).toContain("Policy downgrades")
    expect(await Bun.file(harvestPaths(root).vendorPlan).text()).toContain("SPDX:MIT")
    const cleanRoom = await Bun.file(path.join(harvestPaths(root).cleanRoom, "gizmo-sync-engine.md")).text()
    expect(cleanRoom).toContain("Do not read or copy")
    expect((await readMatrix(root))?.licensePolicy.failClosed).toBe(true)
    expect((await readProfile(root, "gizmo"))?.license.spdx).toBe("GPL-3.0")
  })

  test("complete refuses unscanned candidates unless allowPartial, and matrix needs every candidate", async () => {
    const root = await tmp("es-harvest-partial-")
    await write(root, "vendor/LICENSE", MIT)
    await call(
      root,
      "es_harvest_plan",
      {
        objective: "x",
        candidates: [
          { name: "one", source: "local:vendor" },
          { name: "two", source: "local:vendor" },
        ],
      },
      "harvester",
    )
    await call(root, "es_harvest_scan", { candidate: "one" }, "harvester")
    await expect(call(root, "es_harvest_matrix", { rows: [] }, "harvester")).rejects.toThrow(
      /Scan these candidates first: two/,
    )
    await expect(call(root, "es_harvest_complete", {}, "harvester")).rejects.toThrow(/not scanned/)
    await expect(call(root, "es_harvest_complete", { allowPartial: true }, "harvester")).rejects.toThrow(/No matrix/)
  })
})

describe("stored state is never trusted for policy", () => {
  const call = (root: string, name: string, input: Record<string, unknown>) =>
    harvestTools({ root })
      .find((tool) => tool.name === name)!
      .execute(input, { agent: "harvester" })

  const scanned = async () => {
    const root = await tmp("es-harvest-seal-")
    await write(root, "gpl/COPYING", GPL3)
    await write(root, "gpl/src/b.ts", "export const b = 2\n")
    await call(root, "es_harvest_plan", { objective: "x", candidates: [{ name: "gizmo", source: "local:gpl" }] })
    await call(root, "es_harvest_scan", { candidate: "gizmo" })
    return root
  }
  const vendorRow = { rows: [{ feature: "sync", cells: [{ candidate: "gizmo", verdict: "vendor" }] }] }

  test("a hand-edited profile cannot authorize vendoring: licences come from the bytes", async () => {
    const root = await scanned()
    const file = harvestPaths(root).profile("gizmo")
    const profile = JSON.parse(await Bun.file(file).text())
    profile.license = { ...profile.license, spdx: "MIT", family: "permissive", verified: true }
    await writeFile(file, JSON.stringify(profile))
    expect(await call(root, "es_harvest_matrix", vendorRow)).toContain("clean-room 1")
  })

  test("a hand-edited matrix is re-checked at completion", async () => {
    const root = await scanned()
    await call(root, "es_harvest_matrix", vendorRow)
    const file = harvestPaths(root).matrix
    const matrix = JSON.parse(await Bun.file(file).text())
    matrix.rows[0].cells[0] = { candidate: "gizmo", verdict: "vendor" }
    await writeFile(file, JSON.stringify(matrix))
    const done = await call(root, "es_harvest_complete", {})
    expect(done).toContain("no longer passed the licence policy")
    expect(await Bun.file(harvestPaths(root).vendorPlan).text()).not.toContain("(vendor)")
    expect((await readMatrix(root))?.rows[0]?.cells[0]?.verdict).toBe("clean-room")
  })

  test("a plan may narrow the configured licence whitelist, never widen it", async () => {
    const root = await tmp("es-harvest-whitelist-")
    await write(root, "a/LICENSE", MIT)
    const tools = harvestTools({ root, whitelist: ["Apache-2.0"] })
    const plan = tools.find((tool) => tool.name === "es_harvest_plan")!
    const out = await plan.execute(
      { objective: "x", candidates: [{ name: "a", source: "local:a" }], whitelist: ["MIT", "Apache-2.0"] },
      { agent: "harvester" },
    )
    expect(out).toContain("Ignored (not in the configured licence whitelist")
    expect(out).toContain("whitelist: Apache-2.0")
    const scan = await tools
      .find((tool) => tool.name === "es_harvest_scan")!
      .execute({ candidate: "a" }, { agent: "harvester" })
    expect(scan).toContain("not on the license whitelist")
  })

  test("candidate ids never collide with the reserved notes/ and clean-room/ dirs", async () => {
    const root = await tmp("es-harvest-reserved-")
    await write(root, "a/x.ts", "export const x = 1\n")
    const planned = await call(root, "es_harvest_plan", {
      objective: "x",
      candidates: [
        { name: "notes", source: "local:a" },
        { name: "clean room", source: "local:a" },
      ],
    })
    expect(planned).toContain("notes-2")
    expect(planned).toContain("clean-room-2")
  })
})

describe("agent confinement", () => {
  const call = (root: string, name: string, input: Record<string, unknown>, stateDir?: string) =>
    harvestTools({ root, ...(stateDir ? { stateDir } : {}) })
      .find((tool) => tool.name === name)!
      .execute(input, { agent: "harvester" })
  const plan = (root: string, source: string, stateDir?: string) =>
    call(root, "es_harvest_plan", { objective: "x", candidates: [{ name: "c", source }], force: true }, stateDir)

  test("local and file-path sources must stay inside the project; the state dir never", async () => {
    const root = await tmp("es-harvest-root-")
    const outside = await tmp("es-harvest-outside-")
    await writeFile(path.join(outside, "key"), "SIGNING-KEY")
    await expect(plan(root, `local:${outside}`)).rejects.toThrow(/outside the project/)
    await expect(plan(root, `git:${outside}`)).rejects.toThrow(/outside the project/)
    await expect(plan(root, `git:file://${outside}`)).rejects.toThrow(/outside the project/)
    await expect(plan(root, "git:ext::sh -c touch% /tmp/pwned")).rejects.toThrow(/transport/)
    await write(root, "state/key", "SIGNING-KEY")
    await expect(plan(root, "local:state", path.join(root, "state"))).rejects.toThrow(/private state/)
    // Even a plan written before the check cannot scan outside the project.
    await expect(scanSource(root, "c", { kind: "local", path: outside }, { regexOnly: true })).rejects.toThrow(
      /outside the project/,
    )
    // Humans (the es CLI) may scan elsewhere, but still never the state dir.
    const human = await scanSource(root, "c", { kind: "local", path: outside }, { regexOnly: true, allowOutside: true })
    expect(human.license.spdx).toBe("unknown")
    await expect(
      scanSource(root, "s", { kind: "local", path: outside }, { allowOutside: true, stateDir: outside }),
    ).rejects.toThrow(/private state/)
  })

  test("symlinks in harvested content are never followed", async () => {
    const root = await tmp("es-harvest-link-")
    const outside = await tmp("es-harvest-secret-")
    await writeFile(path.join(outside, "secret.txt"), "TOP-SECRET")
    await writeFile(path.join(outside, "LICENSE"), MIT)
    await write(root, "cand/src/a.ts", "export const a = 1\n")
    await symlink(path.join(outside, "secret.txt"), path.join(root, "cand/leak.txt"))
    await symlink(path.join(outside, "LICENSE"), path.join(root, "cand/LICENSE"))
    await symlink(outside, path.join(root, "cand/linked-dir"))
    await plan(root, "local:cand")
    const scanned = await call(root, "es_harvest_scan", { candidate: "c" })
    expect(scanned).toContain("License: unknown")
    await expect(call(root, "es_harvest_read", { candidate: "c", file: "leak.txt" })).rejects.toThrow(/outside|symlink/)
    await expect(call(root, "es_harvest_read", { candidate: "c", file: "linked-dir/secret.txt" })).rejects.toThrow(
      /outside|symlink/,
    )
    expect(await call(root, "es_harvest_read", { candidate: "c", file: "src/a.ts" })).toContain("export const a")
  })

  test("scanning never runs git inside harvested content (no repo config executes)", async () => {
    const root = await tmp("es-harvest-fsmon-")
    const fx = await gitRepo("es-harvest-fsmon-repo-")
    dirs.push(fx.root)
    const sentinel = path.join(root, "FSMONITOR_RAN")
    await write(fx.root, "src/a.ts", "export const a = 1\n")
    await commitAll(fx.root)
    const { run } = await import("../src/util/proc.ts")
    await run(["git", "config", "core.fsmonitor", `touch ${sentinel}; false`], { cwd: fx.root })
    // Move the repo inside the project so an agent may scan it.
    await rename(fx.root, path.join(root, "cand"))
    await plan(root, "local:cand")
    await call(root, "es_harvest_scan", { candidate: "c" })
    expect(await Bun.file(sentinel).exists()).toBe(false)
    const profile = await readProfile(root, "c")
    expect(profile?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(profile?.size.files).toBe(1)
  })
})

async function gitRepoCommit(root: string): Promise<string> {
  const { run } = await import("../src/util/proc.ts")
  return (await run(["git", "rev-parse", "HEAD"], { cwd: root })).stdout.trim()
}

async function commitAll(root: string): Promise<void> {
  const { run } = await import("../src/util/proc.ts")
  await run(["git", "add", "-A"], { cwd: root })
  await run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixture"], { cwd: root })
}

describe("callable harvest target (#109)", () => {
  const target = (root: string, input: Record<string, unknown>, agent = "grill") =>
    harvestTools({ root })
      .find((tool) => tool.name === "es_harvest_target")!
      .execute(input, { agent })
  const verdictsOf = (text: string) => {
    const json = /--- verdicts \(JSON\) ---\n(\[[\s\S]*\])[\s]*$/.exec(text)?.[1]
    expect(json).toBeDefined()
    return JSON.parse(json!) as Array<{
      target: string
      license: { spdx: string; family: string; verified: boolean }
      verdict: string
      attribution?: string
      provenance: { origin: string; commit?: string; scannedAt: string }
    }>
  }
  const localLib = async (root: string, dir: string, license: string | undefined) => {
    await write(root, `${dir}/src/a.ts`, "export const a = 1\n")
    if (license !== undefined) await write(root, `${dir}/LICENSE`, license)
  }

  test("fail-closed verdicts: permissive depends, copyleft and unknown go clean-room", async () => {
    const root = await tmp("es-target-")
    await localLib(root, "mit-lib", MIT)
    await localLib(root, "gpl-lib", GPL3)
    await localLib(root, "mystery-lib", undefined)
    for (const agent of ["grill", "factory", "scout", "harvester"]) {
      const text = await target(
        root,
        { objective: "vet widget libs", targets: ["local:mit-lib", "local:gpl-lib", "local:mystery-lib"] },
        agent,
      )
      const verdicts = verdictsOf(text)
      expect(verdicts.map((item) => [item.target, item.verdict])).toEqual([
        ["local:mit-lib", "depend"],
        ["local:gpl-lib", "clean-room"],
        ["local:mystery-lib", "clean-room"],
      ])
      expect(verdicts[0]?.license).toMatchObject({ spdx: "MIT", verified: true })
      expect(verdicts[0]?.attribution).toContain("SPDX:MIT")
      expect(verdicts[1]?.license).toMatchObject({ spdx: "GPL-3.0", family: "copyleft" })
      expect(verdicts[2]?.license.spdx).toBe("unknown")
      for (const item of verdicts) {
        expect(typeof item.provenance.origin).toBe("string")
        expect(typeof item.provenance.scannedAt).toBe("string")
      }
    }
    // Strangers get no verdicts.
    await expect(target(root, { objective: "x", targets: ["local:mit-lib"] }, "es-programmer")).rejects.toThrow(
      /Only the/,
    )
  })

  test("confinement and the per-call target cap", async () => {
    const root = await tmp("es-target-cap-")
    const outside = await tmp("es-target-outside-")
    await localLib(root, "ok-lib", MIT)
    await expect(target(root, { objective: "x", targets: [`local:${outside}`] })).rejects.toThrow(/outside the project/)
    await expect(target(root, { objective: "x", targets: ["a", "b", "c", "d", "e", "f"] })).rejects.toThrow(/at most 5/)
    await expect(target(root, { objective: "x", targets: [] })).rejects.toThrow(/at least one/)
    await expect(target(root, { targets: ["local:ok-lib"] })).rejects.toThrow(/objective/)
  })

  test("runs are isolated; profiles land under the run", async () => {
    const root = await tmp("es-target-runs-")
    await localLib(root, "solo-lib", MIT)
    await target(root, { objective: "x", targets: ["local:solo-lib"], run: "r1" })
    await target(root, { objective: "x", targets: ["local:solo-lib"], run: "r2" })
    const { readProfile: readRunProfile } = await import("../src/index.ts")
    const first = await readRunProfile(root, "solo-lib", "r1")
    const second = await readRunProfile(root, "solo-lib", "r2")
    expect(first?.license.spdx).toBe("MIT")
    expect(second?.license.spdx).toBe("MIT")
    expect(first).not.toBe(second)
  })

  test("prior-art records validate on write and read; the brainstormer may search", async () => {
    const root = await tmp("es-prior-art-")
    const { recordPriorArt, readPriorArt, priorArtUrls } = await import("../src/index.ts")
    await expect(
      recordPriorArt(root, [{ idea: "x", query: "y", status: "bogus", results: [], searchedAt: "now" } as never]),
    ).rejects.toThrow()
    // A corrupt record on disk is dropped on read, never trusted.
    const { factoryLayout } = await import("../src/layout.ts")
    const { writeJson } = await import("../src/util/fs.ts")
    await writeJson(path.join(factoryLayout(root).runtime, "harvest", "prior-art.json"), [
      { idea: "x", query: "y", status: "ok", results: [{ title: "t", url: "https://x.test" }], searchedAt: "now" },
      { idea: "bad", query: 42, status: "ok", results: "nope", searchedAt: "now" },
    ])
    expect(await readPriorArt(root)).toHaveLength(1)
    // Run-keyed records: a brainstorm run sees its own searches plus legacy global ones.
    await recordPriorArt(root, [
      {
        idea: "a",
        query: "qa",
        status: "ok",
        results: [{ title: "ra", url: "https://a.test" }],
        searchedAt: "now",
        run: "ra",
      },
      {
        idea: "b",
        query: "qb",
        status: "ok",
        results: [{ title: "rb", url: "https://b.test" }],
        searchedAt: "now",
        run: "rb",
      },
    ])
    expect(await priorArtUrls(root, "ra")).toEqual(new Set(["https://x.test", "https://a.test"]))
    expect(await priorArtUrls(root, "rb")).toEqual(new Set(["https://x.test", "https://b.test"]))
    // The brainstormer (and grill/factory) may record prior art with the mocked API.
    const fetch = (async () =>
      Response.json({
        items: [{ full_name: "acme/cache", name: "cache", html_url: "https://github.com/acme/cache" }],
      })) as unknown as typeof globalThis.fetch
    for (const agent of ["harvester", "brainstormer", "grill", "factory"]) {
      const priorArt = harvestTools({ root, fetch }).find((tool) => tool.name === "es_harvest_prior_art")!
      const text = await priorArt.execute(
        { ideas: [{ id: "b001", title: "cache", text: "a cache layer for speed" }], run: "shared" },
        { agent },
      )
      expect(text).toContain("acme/cache")
    }
    await expect(
      harvestTools({ root, fetch })
        .find((tool) => tool.name === "es_harvest_prior_art")!
        .execute({ ideas: [{ id: "b001", title: "cache", text: "a cache layer for speed" }] }, { agent: "scout" }),
    ).rejects.toThrow(/Only the/)
    expect(await priorArtUrls(root, "shared")).toContain("https://github.com/acme/cache")
  })
})
