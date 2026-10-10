// Trust pinning verbs stay terminal-only (#181 §2, #221 per-verb pipe gaps).
// Pipe (non-interactive) runs of every human-gated trust verb refuse with code
// 3 and record nothing; the shell policy denies the same verbs for every
// agent. No test here runs a real human verb: the only confirms are pipes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  evaluateShell,
  Factory,
  factoryLayout,
  gateRunner,
  invokesHumanOnly,
  sealHumanKey,
  verifyControl,
} from "@heretek-ai/es-core"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

const PASSPHRASE = "test-passphrase-181"

let root: string
let state: string
const realXdgConfig = process.env.XDG_CONFIG_HOME
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-trust-pinning-"))
  state = await mkdtemp(path.join(tmpdir(), "es-trust-pinning-state-"))
  process.env.XDG_CONFIG_HOME = path.join(state, "xdg-config")
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# x\n")
  await git("add", "-A")
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  await sealHumanKey(PASSPHRASE, state)
})
afterEach(async () => {
  if (realXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = realXdgConfig
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }
const run = async (argv: string[], confirm: ConfirmIO = pipe) => {
  const printed: string[] = []
  const code = await main(argv, { print: (text) => printed.push(text), confirm, cwd: root, stateDir: state })
  return { code, out: printed.join("\n") }
}
const trustFile = () => path.join(state, "trust.json")
const waiverDir = () => factoryLayout(root).waivers

describe("trust verbs refuse a pipe (#221)", () => {
  test("es trust needs a terminal and trusts nothing", async () => {
    await mkdir(factoryLayout(root).dir, { recursive: true })
    await writeFile(
      factoryLayout(root).gates,
      JSON.stringify({
        version: 1,
        commands: [{ id: "probe", kind: "test", command: "touch RAN" }],
        security: { gitleaks: "off", osv: "off" },
      }),
    )
    const result = await run(["trust"])
    expect(result.code).toBe(3)
    expect(result.out).toContain("interactive terminal")
    expect(await Bun.file(trustFile()).exists()).toBe(false)
  })

  test("es waive needs a terminal and records nothing", async () => {
    const result = await run(["waive", "security/*", "--reason", "legacy code under migration"])
    expect(result.code).toBe(3)
    expect(result.out).toContain("interactive terminal")
    expect(await Bun.file(path.join(waiverDir(), "security-abc.json")).exists()).toBe(false)
    const { readdir } = await import("node:fs/promises")
    expect(await readdir(waiverDir()).catch(() => [])).toEqual([])
  })

  test("es rebaseline needs a terminal and keeps the drift", async () => {
    const { rebaseline } = await import("@heretek-ai/es-core")
    await rebaseline(root, "test")
    await mkdir(factoryLayout(root).dir, { recursive: true })
    await writeFile(factoryLayout(root).config, '{"pr":"off"}\n')
    expect((await verifyControl(root)).clean).toBe(false)
    const result = await run(["rebaseline"])
    expect(result.code).toBe(3)
    expect(result.out).toContain("interactive terminal")
    expect((await verifyControl(root)).clean).toBe(false)
  })

  test("es reseal --sign needs a terminal and keeps the mismatch", async () => {
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    await factory.begin("human:tester")
    const stateFile = factoryLayout(root).state
    await writeFile(stateFile, `${await Bun.file(stateFile).text()} `)
    const result = await run(["reseal", "--sign"])
    expect(result.code).toBe(3)
    expect(result.out).toContain("interactive terminal")
    await expect(factory.read()).rejects.toThrow("signature mismatch")
  })
})

describe("agent shells cannot reach human-gated trust verbs", () => {
  test("the policy denies trust, waive, rebaseline and reseal for every agent", () => {
    for (const command of [
      "es trust",
      "es waive lint/check --reason legacy",
      "es rebaseline",
      "es reseal --sign",
      "es approve frontier",
    ]) {
      expect([command, invokesHumanOnly(command)]).toEqual([command, true])
      for (const agent of [undefined, "build", "factory", "es-programmer"]) {
        const decision = evaluateShell({ root, stateDir: state }, agent, command, { sandboxAvailable: true })
        expect([command, agent, decision.effect]).toEqual([command, agent, "deny"])
        if (decision.effect === "deny") expect(decision.reason).toContain("human-only")
      }
    }
  })

  test("reads keep working: help and status stay allowed", () => {
    expect(invokesHumanOnly("es trust --help")).toBe(false)
    expect(evaluateShell({ root, stateDir: state }, "build", "es status", { sandboxAvailable: true }).effect).toBe(
      "allow",
    )
  })
})
