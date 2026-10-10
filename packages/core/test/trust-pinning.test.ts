// Trust pinning, waivers, rebaseline and reseal: integration against the real
// OpenCode v2 host (issue #181 §2) plus the proof-gap closers from #221 and the
// waiver-file drift case. Real in-process host via packages/testkit (scripted
// fake LLM); must also pass under scripts/v2-head.sh.
//
// Convention: the test harness acts as the human/system out of band (fs writes,
// rebaseline, trustProject, signEngineFile). The scripted agent only ever runs
// the denied or read-only path; no test runs a real human verb.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness } from "../../testkit/src/index.ts"
import {
  canonicalPath,
  commandSetHash,
  Factory,
  factoryLayout,
  GatesConfigSchema,
  gateRunner,
  type HumanSigner,
  isTrusted,
  rebaseline,
  runGates,
  sealHumanKey,
  signEngineFile,
  trustProject,
  unlockHumanKey,
  verifyControl,
} from "../src/index.ts"

const PASSPHRASE = "test-passphrase-181"
const FAKE_TOKEN = `ghp_${"Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"}`
const pluginDir = path.resolve(import.meta.dir, "../../opencode")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const QUIET_SECURITY = { security: { gitleaks: "off", osv: "off" } } as const
const baselineGates = JSON.stringify({ version: 1, commands: [], ...QUIET_SECURITY })

let h: Harness
let state: string
let signer: HumanSigner

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-trust-pinning-"))
  await sealHumanKey(PASSPHRASE, state)
  signer = await unlockHumanKey(PASSPHRASE, state)
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# trust pinning\n" },
  })
  await mkdir(path.join(h.directory, ".factory"), { recursive: true })
  await writeFile(path.join(h.directory, ".factory/gates.json"), `${baselineGates}\n`)
  await rebaseline(h.directory, "test")
}, 120_000)
afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

const writeRoot = async (file: string, text: string) => {
  await mkdir(path.dirname(path.join(h.directory, file)), { recursive: true })
  await writeFile(path.join(h.directory, file), text)
}
const gatesFile = () => path.join(h.directory, ".factory/gates.json")

describe("control writes through the host (#181 §2)", () => {
  test("an agent edit of .factory/gates.json is denied and changes nothing", async () => {
    const before = await readFile(gatesFile(), "utf8")
    const edited = await h.run(`edit the gates ${call("edit", { path: ".factory/gates.json", content: "pwned" })}`, {
      agent: "factory",
    })
    expect(edited.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["edit:error"])
    expect(edited.tools[0]?.text).toContain("factory control file")
    const written = await h.run(`write the gates ${call("write", { path: ".factory/gates.json", content: "pwned" })}`, {
      agent: "factory",
    })
    expect(written.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["write:error"])
    expect(written.tools[0]?.text).toContain("factory control file")
    expect(await readFile(gatesFile(), "utf8")).toBe(before)
  }, 60_000)

  test("an out-of-band hand edit to gates.json is drift and halts the gates", async () => {
    const before = await readFile(gatesFile(), "utf8")
    await writeFile(
      gatesFile(),
      JSON.stringify({
        version: 1,
        commands: [{ id: "evil", kind: "test", command: "touch PWNED" }],
        ...QUIET_SECURITY,
      }),
    )
    try {
      const check = await verifyControl(h.directory)
      expect(check.clean).toBe(false)
      expect(check.violations.join("\n")).toContain(".factory/gates.json changed")
      const { tools } = await h.run(`run the gates ${call("es_gates_run", {})}`, { agent: "factory" })
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["es_gates_run:completed"])
      expect(tools[0]?.text).toContain("Gates failed")
      expect(tools[0]?.text).toContain("integrity/control-drift")
      expect(tools[0]?.text).toContain(".factory/gates.json changed")
      expect(await Bun.file(path.join(h.directory, "PWNED")).exists()).toBe(false)
    } finally {
      await writeFile(gatesFile(), before)
      await rebaseline(h.directory, "test")
    }
  }, 60_000)

  test("waiver files are pinned: an appeared or changed waiver is drift and halts the gates", async () => {
    const waiver = path.join(h.directory, ".factory/waivers/drift-case.json")
    await writeRoot(".factory/waivers/drift-case.json", JSON.stringify({ hello: "planted" }))
    try {
      expect((await verifyControl(h.directory)).violations.join("\n")).toContain("drift-case.json appeared")
      const appeared = await h.run(`run the gates ${call("es_gates_run", {})}`, { agent: "factory" })
      expect(appeared.tools[0]?.text).toContain("Gates failed")
      expect(appeared.tools[0]?.text).toContain("integrity/control-drift")
      expect(appeared.tools[0]?.text).toContain("appeared")
      await rebaseline(h.directory, "test")
      await writeFile(waiver, JSON.stringify({ hello: "changed" }))
      expect((await verifyControl(h.directory)).violations.join("\n")).toContain("drift-case.json changed")
      const changed = await h.run(`run the gates ${call("es_gates_run", {})}`, { agent: "factory" })
      expect(changed.tools[0]?.text).toContain("Gates failed")
      expect(changed.tools[0]?.text).toContain("drift-case.json changed")
    } finally {
      await rm(waiver, { force: true })
      await rebaseline(h.directory, "test")
    }
  }, 60_000)
})

describe("waivers and trust at gate time (#221 gaps)", () => {
  test("an expired signed waiver is ignored at gate time", async () => {
    await writeRoot("src/config.ts", `export const token = "${FAKE_TOKEN}"\n`)
    // Hand-aged: signed by the human key but already expired. recordWaiver
    // refuses to create these, so the test signs the record directly.
    const now = Date.now()
    const unsigned = {
      version: 2 as const,
      id: "expired-fixture",
      rule: "security/secret-github-token",
      files: "src/config.ts",
      reason: "fixture value, not a real token",
      approvedBy: "tester",
      approvedAt: new Date(now - 86_400_000).toISOString(),
      expiresAt: new Date(now - 1_000).toISOString(),
      channel: "cli" as const,
      auditHead: null,
    }
    await writeRoot(
      ".factory/waivers/expired-fixture.json",
      JSON.stringify({ ...unsigned, signature: signer.sign(unsigned) }),
    )
    await rebaseline(h.directory, "test")
    try {
      const { tools } = await h.run(`run the gates ${call("es_gates_run", { files: ["src/config.ts"] })}`, {
        agent: "factory",
      })
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["es_gates_run:completed"])
      expect(tools[0]?.text).toContain("security/secret-github-token")
      const report = await runGates({
        root: h.directory,
        scope: "touched",
        touched: ["src/config.ts"],
        stateDir: state,
        config: GatesConfigSchema.parse({ commands: [], ...QUIET_SECURITY }),
      })
      expect(report.findings.some((finding) => finding.rule === "security/secret-github-token")).toBe(true)
      expect(report.waived).toBe(0)
    } finally {
      await rm(path.join(h.directory, "src/config.ts"), { force: true })
      await rm(path.join(h.directory, ".factory/waivers/expired-fixture.json"), { force: true })
      await rebaseline(h.directory, "test")
    }
  }, 60_000)

  test("a forged trust.json entry is not trusted and the gates refuse to run", async () => {
    const cfg = GatesConfigSchema.parse({
      commands: [{ id: "probe", kind: "test", command: "touch TRUST-RAN" }],
      ...QUIET_SECURITY,
    })
    const { hash, lines } = await commandSetHash(h.directory, cfg.commands)
    await trustProject(h.directory, hash, lines, { stateDir: state, signer })
    expect(await isTrusted(h.directory, hash, state)).toBe(true)
    const trustFile = path.join(state, "trust.json")
    const raw = JSON.parse(await readFile(trustFile, "utf8")) as {
      projects: Record<string, Record<string, { signature: { sig: string } }>>
    }
    raw.projects[canonicalPath(h.directory)]!.gates!.signature.sig = `${"A".repeat(43)}=`
    await writeFile(trustFile, JSON.stringify(raw))
    const before = await readFile(gatesFile(), "utf8")
    await writeFile(gatesFile(), JSON.stringify({ version: 1, commands: cfg.commands, ...QUIET_SECURITY }))
    await rebaseline(h.directory, "test")
    try {
      expect(await isTrusted(h.directory, hash, state)).toBe(false)
      const { tools } = await h.run(`run the gates ${call("es_gates_run", { scope: "full" })}`, { agent: "factory" })
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["es_gates_run:completed"])
      expect(tools[0]?.text).toContain("trust/untrusted")
      expect(await Bun.file(path.join(h.directory, "TRUST-RAN")).exists()).toBe(false)
    } finally {
      await trustProject(h.directory, hash, lines, { stateDir: state, signer })
      await rm(path.join(h.directory, "TRUST-RAN"), { force: true })
      await writeFile(gatesFile(), before)
      await rebaseline(h.directory, "test")
    }
  }, 60_000)
})

describe("agent shells and sealed state through the host (#181 §2)", () => {
  test("an agent shell running human-gated verbs is refused", async () => {
    for (const command of ["es trust", "es waive lint/check --reason x", "es reseal --sign", "es rebaseline"]) {
      const { tools } = await h.run(`shell ${call("shell", { command })}`, { agent: "factory" })
      expect([command, ...tools.map((tool) => `${tool.name}:${tool.status}`)]).toEqual([command, "shell:error"])
      expect([command, tools[0]?.text]).toEqual([command, expect.stringContaining("human-only")])
    }
  }, 60_000)

  test("a forged state.json seal refuses reads with the re-sign hint", async () => {
    const factory = new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
    await factory.begin("human:tester")
    const layout = factoryLayout(h.directory)
    await writeFile(layout.state, `${await readFile(layout.state, "utf8")} `)
    try {
      await expect(factory.read()).rejects.toThrow("es reseal --sign")
      await expect(factory.read()).rejects.toThrow("signature mismatch")
      const { tools } = await h.run(`status ${call("es_status", {})}`, { agent: "factory" })
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["es_status:error"])
      expect(tools[0]?.text).toContain("es reseal --sign")
      await rm(`${layout.state}.sig`)
      await expect(factory.read()).rejects.toThrow("es reseal --sign")
    } finally {
      // What `es reseal --sign` does after review: re-sign the reviewed bytes.
      await signEngineFile(layout.state, state)
    }
    expect((await factory.read())?.stage).toBe("GRILL")
  }, 60_000)
})
