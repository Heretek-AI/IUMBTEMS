// Clean-room isolation (#159): the workspace test, lint and typecheck entry
// points stay inside packages/. Local-only reference checkouts (review/,
// evals/results/) and nested worktrees carry third-party suites that hang and
// biome.json files that are nested roots, so nothing may walk them. Web
// provider keys exported in the developer's shell are the same kind of leak
// (#312). Each test runs the real root config against a throwaway tree with
// planted intruders.
import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "../../..")
// Every gitignored place a foreign checkout can sit beside packages/.
const OUTSIDE = ["review/ext", "evals/results/run", ".worktrees/ticket", ".fleet/task", ".factory/worktrees/seat"]

// Each fixture suite logs its own label when loaded, so the assertions do not
// depend on the reporter format; intruders also fail, like the real ones.
const suite = (label: string, intruder: boolean) =>
  [
    'import { expect, test } from "bun:test"',
    'import { appendFileSync } from "node:fs"',
    "",
    `appendFileSync(process.env.CLEAN_ROOM_LOG!, "${label}\\n")`,
    "",
    `test("${label}", () => expect(${intruder}).toBe(false))`,
    "",
  ].join("\n")

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture(options: { bunfig: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "es-clean-room-"))
  dirs.push(root)
  const rootManifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
    scripts: { test: string }
  }
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts: { test: rootManifest.scripts.test } }),
  )
  await cp(path.join(repo, "biome.json"), path.join(root, "biome.json"))
  if (options.bunfig) await cp(path.join(repo, "bunfig.toml"), path.join(root, "bunfig.toml"))
  await mkdir(path.join(root, "scripts"))
  await cp(path.join(repo, "scripts/packages.ts"), path.join(root, "scripts/packages.ts"))
  // bunfig.toml names a preload, so it travels with the config.
  if (options.bunfig) await cp(path.join(repo, "scripts/test-preload.ts"), path.join(root, "scripts/test-preload.ts"))

  // beta takes the `--conditions=browser` leg of the test script, alpha the other.
  const manifests = {
    alpha: { name: "@fixture/alpha", version: "0.0.0", private: true },
    beta: { name: "@fixture/beta", version: "0.0.0", private: true, esTest: { conditions: ["browser"] } },
  }
  for (const [pkg, manifest] of Object.entries(manifests)) {
    await mkdir(path.join(root, "packages", pkg, "test"), { recursive: true })
    await writeFile(path.join(root, "packages", pkg, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(path.join(root, "packages", pkg, "test", "own.test.ts"), suite(`own:${pkg}`, false))
    for (const outside of OUTSIDE) {
      const dir = path.join(root, outside, "packages", pkg, "test")
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, "intruder.test.ts"), suite(`intruder:${outside}:${pkg}`, true))
    }
  }
  for (const outside of OUTSIDE) await writeFile(path.join(root, outside, "biome.json"), '{ "root": true }\n')
  return root
}

async function run(root: string, cmd: string[], env: Record<string, string> = {}) {
  const log = path.join(root, "loaded.log")
  await writeFile(log, "")
  const proc = Bun.spawn(cmd, {
    cwd: root,
    env: { ...process.env, ...env, CLEAN_ROOM_LOG: log },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const loaded = (await readFile(log, "utf8")).split("\n").filter(Boolean).sort()
  return { exit, loaded, output: stdout + stderr }
}

describe("test runner isolation", () => {
  test("`bun run test` scopes itself to workspace packages without any runner config", async () => {
    const root = await fixture({ bunfig: false })
    const result = await run(root, ["bun", "run", "test"])
    expect(result.loaded).toEqual(["own:alpha", "own:beta"])
    expect(result.exit).toBe(0)
  })

  test("a bare `bun test` discovers suites under packages/ only", async () => {
    const root = await fixture({ bunfig: true })
    const result = await run(root, ["bun", "test"])
    expect(result.loaded).toEqual(["own:alpha", "own:beta"])
    expect(result.exit).toBe(0)
  })

  test("a bare path filter cannot reach a reference checkout", async () => {
    const root = await fixture({ bunfig: true })
    const result = await run(root, ["bun", "test", "packages/alpha"])
    expect(result.loaded).toEqual(["own:alpha"])
    expect(result.exit).toBe(0)
  })
})

describe("ambient environment isolation", () => {
  // Every setting the research providers and the gateway backend read.
  const PROVIDER_KEYS = [
    "BRAVE_API_KEY",
    "FIRECRAWL_API_KEY",
    "FIRECRAWL_API_URL",
    "SEARXNG_URL",
    "ES_SCRAPER_SWARM_URL",
    "ES_SCRAPER_SWARM_TOKEN",
  ]

  test("web provider settings from the developer shell never reach a suite", async () => {
    const root = await fixture({ bunfig: true })
    await writeFile(
      path.join(root, "packages/alpha/test/env.test.ts"),
      [
        'import { expect, test } from "bun:test"',
        'import { appendFileSync } from "node:fs"',
        "",
        `const seen = ${JSON.stringify(PROVIDER_KEYS)}.filter((key) => process.env[key] !== undefined)`,
        'appendFileSync(process.env.CLEAN_ROOM_LOG!, "leaked:" + seen.join(",") + "\\n")',
        "",
        'test("probe", () => expect(seen).toEqual([]))',
        "",
      ].join("\n"),
    )
    const ambient = Object.fromEntries(PROVIDER_KEYS.map((key) => [key, "ambient-must-not-leak"]))
    const result = await run(root, ["bun", "test", "./packages/alpha/test/env.test.ts"], ambient)
    expect(result.loaded).toEqual(["leaked:"])
    expect(result.exit).toBe(0)
  })
})

describe("lint and typecheck isolation", () => {
  test("`biome check .` ignores nested root configs outside packages/", async () => {
    const root = await fixture({ bunfig: true })
    const result = await run(root, [path.join(repo, "node_modules/.bin/biome"), "check", "."])
    expect(result.output).not.toContain("nested root configuration")
    expect(result.exit).toBe(0)
  })

  test("tsconfig.base.json excludes the reference checkouts for every package", async () => {
    const base = JSON.parse(await readFile(path.join(repo, "tsconfig.base.json"), "utf8")) as { exclude?: string[] }
    expect(base.exclude).toEqual(expect.arrayContaining(["review", "evals/results"]))
  })
})
