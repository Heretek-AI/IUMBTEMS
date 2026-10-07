// Darkharvest: deterministic SPDX detection, sources (local/git/registry/API),
// profiles with provenance, the token-budgeted reader, the fail-closed licence
// policy and the tool loop that writes the report, vendor plan and clean-room
// specs.
import { afterEach, describe, expect, test } from "bun:test"
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
  matchSignature,
  parseSource,
  readCandidate,
  readHarvestResult,
  readMatrix,
  readProfile,
  registryMetadata,
  scanSource,
} from "../src/index.ts"
import { gitRepo } from "./helpers.ts"

const MIT = `MIT License

Copyright (c) 2026 Example

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction. The software is provided "as is", without
warranty of any kind.`

const BSD3 = `Copyright (c) 2026, Example
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software.`

const GPL3 = `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
Copyright (C) 2007 Free Software Foundation, Inc.`

const AGPL3 = `GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007`

const ISC = `ISC License
Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.`

const BSD0 = `BSD Zero Clause License
Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted. The software is provided "as is".`

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
  test("signature matching separates the common licences", () => {
    expect(matchSignature(MIT)?.spdx).toBe("MIT")
    expect(matchSignature(BSD3)?.spdx).toBe("BSD-3-Clause")
    expect(matchSignature(BSD3.replace(/3\. Neither the name[\s\S]*$/, ""))?.spdx).toBe("BSD-2-Clause")
    expect(matchSignature(GPL3)?.spdx).toBe("GPL-3.0")
    expect(matchSignature(AGPL3)?.spdx).toBe("AGPL-3.0")
    expect(matchSignature(ISC)?.spdx).toBe("ISC")
    expect(matchSignature(BSD0)?.spdx).toBe("0BSD")
    expect(matchSignature("All rights reserved. Do what you like.")).toBeUndefined()
  })

  test("a LICENSE file beats everything, then headers, then manifest claims", async () => {
    const root = await tmp("es-spdx-")
    await write(root, "LICENSE", MIT)
    await write(root, "package.json", JSON.stringify({ license: "GPL-3.0" }))
    const fromFile = await detectLicense(root)
    expect(fromFile).toMatchObject({ spdx: "MIT", source: "license-file", verified: true, confidence: "high" })
    expect(fromFile.sha256).toMatch(/^[0-9a-f]{64}$/)

    await rm(path.join(root, "LICENSE"))
    await write(root, "src/a.ts", "// SPDX-License-Identifier: Apache-2.0\nexport const x = 1\n")
    const fromHeader = await detectLicense(root)
    expect(fromHeader).toMatchObject({ spdx: "Apache-2.0", source: "spdx-header", verified: true })
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
