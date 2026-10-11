// Packed-tarball contents for the release set (issue #208): what users
// install must carry the runtime (core assets, the CLI bin, the plugin
// server plus the prebuilt TUI) and nothing else — no tests, no private
// packages (`es-fleet`, web, testkit). Packs with `bun pm pack` the way
// scripts/pack-smoke.sh packs, from the single package list
// (scripts/packages.ts, as in packages.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { releasePackages, tarballSlug, workspacePackages } from "../../../scripts/packages.ts"

const root = path.resolve(import.meta.dir, "../../..")

async function run(argv: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${argv.join(" ")} in ${cwd} exited ${code}: ${stderr.slice(-2000)}`)
  return stdout
}

async function tarList(tgz: string): Promise<string[]> {
  const out = await run(["tar", "-tzf", tgz], root)
  return out.split("\n").filter(Boolean)
}

async function tarRead(tgz: string, member: string): Promise<string> {
  return run(["tar", "-xzOf", tgz, member], root)
}

const TEST_DIR = new Set(["test", "tests", "__tests__", "__snapshots__"])
const isTestPath = (entry: string) => {
  const parts = entry.split("/")
  return parts.some((part) => TEST_DIR.has(part)) || /\.(test|spec)\.[a-z]+$/.test(parts.at(-1) ?? "")
}

describe("packed release tarballs (issue #208)", () => {
  let out = ""
  const tarballs = new Map<string, string>()

  beforeAll(async () => {
    out = await mkdtemp(path.join(tmpdir(), "es-pack-contents-"))
    const release = await releasePackages(root)
    for (const { dir } of release) await run(["bun", "run", "build"], path.join(root, "packages", dir))
    for (const { dir } of release)
      await run(["bun", "pm", "pack", "--destination", out], path.join(root, "packages", dir))
    const files = await readdir(out)
    for (const { dir, name } of release) {
      const hits = files.filter((file) => file.startsWith(`${tarballSlug(name)}-`) && file.endsWith(".tgz"))
      expect(hits).toHaveLength(1)
      tarballs.set(dir, path.join(out, hits[0]!))
    }
  }, 240_000)
  afterAll(() => rm(out, { recursive: true, force: true }))

  test("the release set is exactly core, cli and the plugin; fleet, web and testkit stay private", async () => {
    expect([...tarballs.keys()].sort()).toEqual(["cli", "core", "opencode"])
    const all = await workspacePackages(root)
    for (const dir of ["fleet", "web", "testkit"]) {
      const pkg = all.find((entry) => entry.dir === dir)!
      expect([dir, pkg.private]).toEqual([dir, true])
      expect(pkg.order).toBeUndefined()
    }
    // No tarball for a private package, even a stale one from an earlier run.
    for (const pkg of all.filter((entry) => entry.private)) {
      const hits = (await readdir(out)).filter(
        (file) => file.startsWith(`${tarballSlug(pkg.name)}-`) && file.endsWith(".tgz"),
      )
      expect([pkg.dir, hits]).toEqual([pkg.dir, []])
    }
  })

  test("packed manifests carry no workspace: protocol", async () => {
    for (const [dir, tgz] of tarballs) {
      const manifest = await tarRead(tgz, "package/package.json")
      expect([dir, manifest.includes("workspace:")]).toEqual([dir, false])
    }
  })

  test("tarballs contain no tests and no private-package payload", async () => {
    for (const [dir, tgz] of tarballs) {
      const entries = await tarList(tgz)
      expect([dir, entries.filter(isTestPath)]).toEqual([dir, []])
      expect([dir, entries.filter((entry) => entry.includes("es-fleet") || entry.includes("es-web"))]).toEqual([
        dir,
        [],
      ])
    }
  })

  test("tarballs ship the runtime payload users need", async () => {
    const has = async (dir: string, member: string) =>
      expect([dir, member, (await tarList(tarballs.get(dir)!)).includes(member)]).toEqual([dir, member, true])
    // Core: compiled entry plus the bundled assets pack-smoke loads
    // (prompts, skills, licence templates).
    await has("core", "package/dist/index.js")
    await has("core", "package/assets/prompts/factory.md")
    await has("core", "package/assets/skills/factory/SKILL.md")
    await has("core", "package/assets/licenses/MIT.template.txt")
    // CLI: the bin users run plus its bundle.
    await has("cli", "package/bin/es.js")
    await has("cli", "package/dist/es.js")
    // Plugin: the server entry the host loads plus the prebuilt TUI (raw
    // .tsx cannot ship: the host Solid transform skips node_modules).
    await has("opencode", "package/server.ts")
    await has("opencode", "package/src/server.ts")
    await has("opencode", "package/dist/tui.js")
  })

  test("the opencode host pin matches what the suites test", async () => {
    const manifest = async (dir: string) =>
      JSON.parse(await Bun.file(path.join(root, "packages", dir, "package.json")).text()) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
    const plugin = await manifest("opencode")
    const kit = await manifest("testkit")
    // Pinned, not a range: the host the plugin runs against is exactly the
    // host the testkit boots.
    expect(plugin.dependencies?.["@opencode/plugin"]).toBe("2.0.24")
    expect(plugin.devDependencies?.["@opencode/sdk"]).toBe("2.0.24")
    expect(kit.dependencies?.["@opencode/sdk"]).toBe(plugin.devDependencies?.["@opencode/sdk"])
    // The packed plugin pins the same host dependency (workspace:* rewritten).
    const packed = JSON.parse(await tarRead(tarballs.get("opencode")!, "package/package.json")) as {
      dependencies?: Record<string, string>
    }
    expect(packed.dependencies?.["@opencode/plugin"]).toBe(plugin.dependencies?.["@opencode/plugin"])
  })
})
