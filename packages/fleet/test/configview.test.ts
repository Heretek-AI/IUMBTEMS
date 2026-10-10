// Read-only config view (#132, preview-only mode): the browser previews
// project-config and gates edits with exact hash diffs, but nothing here
// writes — the no-write proof hashes every file around the calls, and
// `fleet.config.apply` does not exist on the bus.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { planConfigFile, readConfigView } from "../src/configview.ts"

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")
const canon = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

async function repo(header: { config?: unknown; gates?: unknown } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "es-configview-"))
  await mkdir(path.join(root, ".factory"), { recursive: true })
  await writeFile(path.join(root, ".factory", "config.json"), canon(header.config ?? {}))
  await writeFile(path.join(root, ".factory", "gates.json"), canon(header.gates ?? {}))
  return root
}

async function treeHash(root: string): Promise<string> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files.push(full)
    }
  }
  await walk(root)
  files.sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(path.relative(root, file))
    hash.update(await readFile(file))
  }
  return hash.digest("hex")
}

describe("fleet.config.get", () => {
  test("it reads the project config, gates, hashes and drift state", async () => {
    const root = await repo({ config: { licenseWhitelist: ["MIT"] }, gates: { topN: 5 } })
    try {
      const view = await readConfigView(root)
      expect(view.config).toEqual({ licenseWhitelist: ["MIT"] })
      expect(view.configHash).toBe(sha256(canon({ licenseWhitelist: ["MIT"] })))
      expect(view.gates).toMatchObject({ topN: 5 })
      expect(view.gatesHash).toBe(sha256(await readFile(path.join(root, ".factory", "gates.json"), "utf8")))
      expect(view.drift.hasBaseline).toBe(false)
      expect(view.drift.clean).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing files read as absent (null), never as an error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-configview-"))
    try {
      const view = await readConfigView(root)
      expect(view.config).toBeNull()
      expect(view.configHash).toBeNull()
      expect(view.gates).toBeNull()
      expect(view.gatesHash).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("fleet.config.plan", () => {
  test("a valid config edit previews the exact new hash, changed keys and commands", async () => {
    const root = await repo({ config: { licenseWhitelist: ["MIT"] } })
    try {
      const plan = await planConfigFile(root, {
        file: "config",
        content: { licenseWhitelist: ["MIT", "Apache-2.0"], research: { depth: 3 } },
      })
      expect(plan.ok).toBe(true)
      expect(plan.errors).toEqual([])
      expect(plan.oldHash).toBe(sha256(canon({ licenseWhitelist: ["MIT"] })))
      expect(plan.newHash).toBe(sha256(canon({ licenseWhitelist: ["MIT", "Apache-2.0"], research: { depth: 3 } })))
      expect(plan.changedKeys).toEqual(["licenseWhitelist", "research"])
      expect(plan.commands).toEqual([
        'es config set licenseWhitelist ["MIT","Apache-2.0"]',
        'es config set research {"depth":3}',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("strict-schema violations are reported per key (unknown, wrong type, forbidden)", async () => {
    const root = await repo()
    try {
      const unknown = await planConfigFile(root, { file: "config", content: { noSuchKey: 1 } })
      expect(unknown.ok).toBe(false)
      expect(unknown.errors.join("\n")).toMatch(/noSuchKey/)
      const wrongType = await planConfigFile(root, { file: "config", content: { research: { depth: "many" } } })
      expect(wrongType.ok).toBe(false)
      expect(wrongType.errors.join("\n")).toMatch(/depth/)
      const forbidden = await planConfigFile(root, { file: "config", content: { embeddings: {} } })
      expect(forbidden.ok).toBe(false)
      expect(forbidden.errors.join("\n")).toMatch(/embeddings/)
      for (const plan of [unknown, wrongType, forbidden]) expect(plan.commands).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a valid gates edit previews the hash diff and the rebaseline command", async () => {
    const root = await repo({ gates: { topN: 5 } })
    try {
      const plan = await planConfigFile(root, { file: "gates", content: { topN: 7 } })
      expect(plan.ok).toBe(true)
      expect(plan.changedKeys).toEqual(["topN"])
      expect(plan.commands).toEqual(["# save the previewed JSON to .factory/gates.json", "es rebaseline"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("invalid gates and non-object content are refused", async () => {
    const root = await repo()
    try {
      expect((await planConfigFile(root, { file: "gates", content: { topN: -3 } })).ok).toBe(false)
      expect((await planConfigFile(root, { file: "config", content: [1, 2] })).ok).toBe(false)
      expect((await planConfigFile(root, { file: "config", content: "nope" })).ok).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unchanged content previews as a no-op with no commands", async () => {
    const root = await repo({ config: { licenseWhitelist: ["MIT"] } })
    try {
      const plan = await planConfigFile(root, { file: "config", content: { licenseWhitelist: ["MIT"] } })
      expect(plan.ok).toBe(true)
      expect(plan.changedKeys).toEqual([])
      expect(plan.commands).toEqual([])
      expect(plan.newHash).toBe(plan.oldHash)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("preview-only: nothing writes", () => {
  test("get and plan leave every file under the repo and state dir untouched", async () => {
    const root = await repo({ config: { licenseWhitelist: ["MIT"] }, gates: { topN: 5 } })
    const state = await mkdtemp(path.join(tmpdir(), "es-configview-state-"))
    try {
      const beforeRepo = await treeHash(root)
      const beforeState = await treeHash(state)
      await readConfigView(root)
      await planConfigFile(root, { file: "config", content: { research: { depth: 4 } } })
      await planConfigFile(root, { file: "gates", content: { topN: 1 } })
      await planConfigFile(root, { file: "config", content: { bogus: true } })
      expect(await treeHash(root)).toBe(beforeRepo)
      expect(await treeHash(state)).toBe(beforeState)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("fleet.config.* over the bus", () => {
  const TOKEN = "configview-bus-token-with-enough-length"

  async function bus(repoRoot: string) {
    const { TelemetryServer } = await import("../src/telemetry.ts")
    const { fleetPaths } = await import("../src/state.ts")
    const { mkdir } = await import("node:fs/promises")
    const state = await mkdtemp(path.join(tmpdir(), "es-configview-bus-"))
    await mkdir(fleetPaths(state).dir, { recursive: true })
    await writeFile(fleetPaths(state).token, TOKEN, { mode: 0o600 })
    const server = new TelemetryServer({
      stateRoot: state,
      port: 0,
      token: TOKEN,
      getSnapshot: () => ({
        daemon: { running: true, pid: 1, maxUsd: 1, concurrency: 1 },
        tasks: [],
        spendUsd: 0,
        pending: [],
      }),
      configRoot: repoRoot,
    })
    await server.start()
    return { state, server }
  }

  const call = (port: number, method: string, params: unknown) =>
    fetch(`http://127.0.0.1:${port}/fleet/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ method, params }),
    }).then((response) => response.json()) as Promise<{ result?: unknown; error?: { code: number } }>

  test("get and plan round-trip; strict schemas refuse bad params", async () => {
    const root = await repo({ config: { licenseWhitelist: ["MIT"] } })
    const { state, server } = await bus(root)
    try {
      const got = await call(server.port, "fleet.config.get", {})
      expect((got.result as { configHash?: unknown }).configHash).toBe(sha256(canon({ licenseWhitelist: ["MIT"] })))
      const planned = await call(server.port, "fleet.config.plan", {
        file: "gates",
        content: { topN: 3 },
      })
      expect((planned.result as { ok?: unknown }).ok).toBe(true)
      // Strict schemas: unknown file values and extra params are refused.
      expect((await call(server.port, "fleet.config.plan", { file: "bogus", content: {} })).error?.code).toBe(-32602)
      expect(
        (await call(server.port, "fleet.config.plan", { file: "config", content: {}, extra: 1 })).error?.code,
      ).toBe(-32602)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("there is no apply method: preview-only is enforced by the bus", async () => {
    const root = await repo()
    const { state, server } = await bus(root)
    try {
      expect((await call(server.port, "fleet.config.apply", {})).error?.code).toBe(-32601)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
