// The packed plugin installed the way users get it, loaded on the real
// in-process host from the installed (tarball) path — never the workspace
// checkout (issue #208). Packs with `bun pm pack` like scripts/pack-smoke.sh,
// installs the tarballs into a temp project with npm, then boots the testkit
// host against the installed plugin directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness, lastAgentRequest } from "@heretek-ai/es-testkit"
import { releasePackages, tarballSlug } from "../../../scripts/packages.ts"
import { EsRpc } from "../src/rpc-def.ts"

const root = path.resolve(import.meta.dir, "../../..")
const workspacePluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

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

describe("packed plugin install on the real host (issue #208)", () => {
  let out = ""
  let work = ""
  let state = ""
  let installed = ""

  beforeAll(async () => {
    out = await mkdtemp(path.join(tmpdir(), "es-pack-install-packs-"))
    work = await mkdtemp(path.join(tmpdir(), "es-pack-install-work-"))
    state = await mkdtemp(path.join(tmpdir(), "es-pack-install-state-"))
    // The release packages and their tarball slugs, in publish order, from
    // the single source of truth — the same list scripts/pack-smoke.sh uses.
    const release = await releasePackages(root)
    expect(release.map((pkg) => pkg.dir)).toEqual(["core", "cli", "opencode"])
    for (const { dir } of release) await run(["bun", "run", "build"], path.join(root, "packages", dir))
    for (const { dir, name } of release) {
      const slug = tarballSlug(name)
      for (const stale of (await readdir(out)).filter((file) => file.startsWith(`${slug}-`) && file.endsWith(".tgz")))
        await rm(path.join(out, stale))
      await run(["bun", "pm", "pack", "--destination", out], path.join(root, "packages", dir))
    }
    const packed = await readdir(out)
    const tarballs = release.map(({ name }) => {
      const hits = packed.filter((file) => file.startsWith(`${tarballSlug(name)}-`) && file.endsWith(".tgz"))
      expect(hits).toHaveLength(1)
      return path.join(out, hits[0]!)
    })
    // A temp project the way users get it: the packed tarballs, installed
    // with npm (workspace:* already rewritten to real versions by the pack).
    await writeFile(
      path.join(work, "package.json"),
      JSON.stringify({ name: "es-pack-probe", private: true, version: "0.0.0" }),
    )
    await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], work)
    installed = path.join(work, "node_modules", "@heretek-ai", "epistemic-swarm")
    const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")) as {
      name: string
      dependencies?: Record<string, string>
    }
    expect(manifest.name).toBe("@heretek-ai/epistemic-swarm")
    // The host must load this directory, not the workspace checkout.
    expect(await realpath(installed)).not.toBe(await realpath(workspacePluginDir))
    expect(path.relative(await realpath(root), await realpath(installed))).toMatch(/^\.\./)
  }, 300_000)
  afterAll(async () => {
    await rm(out, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })

  test("installed manifests carry no workspace: protocol", async () => {
    const vendor = path.join(work, "node_modules", "@heretek-ai")
    for (const dir of await readdir(vendor)) {
      const manifest = await readFile(path.join(vendor, dir, "package.json"), "utf8")
      expect([dir, manifest.includes('"workspace:')]).toEqual([dir, false])
    }
  })

  test("the tarball-installed plugin boots on the real host and serves es_status", async () => {
    expect(path.resolve(installed)).toContain("node_modules")
    let h: Harness | undefined
    try {
      h = await boot({
        git: true,
        script: directiveScript,
        plugins: [{ path: installed, options: { stateDir: state, pr: "off" } }],
        files: { "README.md": "# demo\n", ".gitignore": "node_modules/\n" },
      })
      const { tools } = await h.run(`go ${call("es_status")}`)
      expect(tools[0]?.status).toBe("completed")
      expect(tools[0]?.text).toContain("<factory-state>")
      const advertised = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
      expect(advertised).toContain("es_status")
      expect(advertised).toContain("es_gates_run")
      const rpc = (h.opencode as any).rpc(EsRpc)
      const factory = await rpc.factoryState({}, { location: h.location })
      expect(factory.stage).toBe("NONE")
    } finally {
      await h?.close()
    }
  }, 180_000)
})
