// Packaging pin assertions (#212): the opencode triple-pin moves together,
// every release manifest declares an explicit `files` allowlist with no test
// paths, and the `--release` rendering keeps the `<dir> <slug>` contract
// `publish.yml` parses. File reads only: no network, no registry, no pack.
// Structural fixes (a peer range, narrower allowlists, publish parsing,
// the runtime-matrix wording) route to S9 via CROSS-SQUAD REQUEST.
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { releasePackages, tarballSlug, workspacePackages } from "../../../scripts/packages.ts"

const root = path.resolve(import.meta.dir, "../../..")
const manifest = async (dir: string) =>
  JSON.parse(await readFile(path.join(root, "packages", dir, "package.json"), "utf8")) as Record<string, any>

describe("the opencode triple-pin moves together", () => {
  test("@opencode/plugin, @opencode/sdk and the e2e CLI share one version", async () => {
    const opencode = await manifest("opencode")
    const plugin = opencode.dependencies?.["@opencode/plugin"] as string
    const sdk = opencode.devDependencies?.["@opencode/sdk"] as string
    expect(plugin).toMatch(/^\d+\.\d+\.\d+$/)
    expect(sdk).toBe(plugin)
    const e2e = await readFile(path.join(root, ".github/workflows/e2e-feedback.yml"), "utf8")
    const cliPins = [...e2e.matchAll(/@opencode\/cli-linux-x64@([0-9A-Za-z._-]+)/g)].map((match) => match[1])
    expect(cliPins.length).toBeGreaterThan(0)
    expect(new Set(cliPins).size).toBe(1)
    expect(cliPins[0]).toBe(plugin)
  })
})

describe("release tarball allowlists", () => {
  test("every release manifest declares an explicit files allowlist with no test paths", async () => {
    for (const pkg of await releasePackages(root)) {
      const files = (await manifest(pkg.dir)).files as unknown
      expect(Array.isArray(files) && (files as unknown[]).length > 0).toBe(true)
      for (const entry of files as string[]) {
        expect(typeof entry).toBe("string")
        expect(entry).not.toMatch(/test|spec|__tests__/i)
      }
    }
  })

  test("fleet and web stay private (never released)", async () => {
    const all = await workspacePackages(root)
    for (const dir of ["fleet", "web"]) {
      expect(all.find((pkg) => pkg.dir === dir)?.private).toBe(true)
    }
  })
})

describe("the --release rendering contract", () => {
  test('every line is "<dir> <slug>" with the slug derived from the manifest name', async () => {
    for (const pkg of await releasePackages(root)) {
      const line = `${pkg.dir} ${tarballSlug(pkg.name)}`
      expect(line).toMatch(/^\S+ \S+$/)
      expect(tarballSlug(pkg.name)).not.toContain(" ")
    }
  })
})
