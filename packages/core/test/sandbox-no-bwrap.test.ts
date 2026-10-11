// No-bwrap refusal for issue #183: without bubblewrap, factory seats get no
// shell (fail closed), factory gate runs halt, and the user's own agents fall
// back to the weaker argv-aware text policy. Uses the sandboxAvailable:false
// seam plus the real PATH probe (bwrap is resolved from PATH by design).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import {
  commandSetHash,
  evaluateShell,
  GatesConfigSchema,
  runGates,
  SANDBOX_MISSING,
  trustProject,
} from "../src/index.ts"
import { bwrapAvailable, resetBwrapProbe } from "../src/util/proc.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let root: string
let state: string
let worktree: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-nobwrap-"))
  state = await mkdtemp(path.join(tmpdir(), "es-nobwrap-state-"))
  worktree = path.join(root, ".factory/worktrees/p1")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
  resetBwrapProbe()
})

const ctx = () => ({ root, worktree, stateDir: state })

describe("no-bwrap refusal (#183)", () => {
  test("factory seats are refused a shell without bubblewrap, naming it", () => {
    for (const agent of ["factory", "es-manager", "es-programmer", "es-qa-functional", "es-research-alpha"]) {
      const decision = evaluateShell(ctx(), agent, "ls", { sandboxAvailable: false })
      expect(decision.effect).toBe("deny")
      expect(decision.effect === "deny" ? decision.reason : "").toContain("bubblewrap")
      expect(decision.effect === "deny" ? decision.reason : "").toContain(SANDBOX_MISSING.slice(0, 24))
    }
    // With bubblewrap the same seats get a sandboxed shell.
    expect(evaluateShell(ctx(), "es-programmer", "ls", { sandboxAvailable: true })).toMatchObject({
      effect: "allow",
      mode: "sandbox",
    })
  })

  test("PATH without bwrap: hiding bwrap from PATH refuses seats and keeps the user text policy", async () => {
    const savedPath = process.env.PATH
    const emptyBin = await mkdtemp(path.join(tmpdir(), "es-nobwrap-bin-"))
    try {
      process.env.PATH = emptyBin
      resetBwrapProbe()
      expect(bwrapAvailable()).toBe(false)
      const refused = evaluateShell(ctx(), "es-qa-functional", "echo hi", { sandboxAvailable: bwrapAvailable() })
      expect(refused.effect).toBe("deny")
      expect(refused.effect === "deny" ? refused.reason : "").toContain("bubblewrap")
      const user = evaluateShell(ctx(), undefined, "echo hi", { sandboxAvailable: bwrapAvailable() })
      expect(user).toEqual({ effect: "allow", mode: "unsandboxed" })
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      resetBwrapProbe()
      await rm(emptyBin, { recursive: true, force: true })
    }
  })

  test("user agents fall back to the weaker argv-aware text policy without bwrap", () => {
    // Plain commands run unsandboxed; the text rules still gate control files.
    expect(evaluateShell(ctx(), undefined, "bun test", { sandboxAvailable: false })).toEqual({
      effect: "allow",
      mode: "unsandboxed",
    })
    expect(evaluateShell(ctx(), "build", "echo hi", { sandboxAvailable: false })).toEqual({
      effect: "allow",
      mode: "unsandboxed",
    })
    expect(evaluateShell(ctx(), undefined, "echo x > .factory/gates.json", { sandboxAvailable: false }).effect).toBe(
      "deny",
    )
    expect(evaluateShell(ctx(), undefined, "cat .factory/gates.json", { sandboxAvailable: false }).effect).toBe("allow")
    // With bubblewrap the user's agent is sandboxed instead.
    expect(evaluateShell(ctx(), undefined, "bun test", { sandboxAvailable: true })).toEqual({
      effect: "allow",
      mode: "sandbox",
      kind: "user",
      offline: false,
    })
  })
})

describe("gate runs without bwrap (#183)", () => {
  let fx: Fixture
  let signer: HumanSigner
  const PASSPHRASE = "test-passphrase-1234"
  beforeEach(async () => {
    fx = await gitRepo("es-nobwrap-gates-")
    await sealHumanKey(PASSPHRASE, fx.state)
    signer = await unlockHumanKey(PASSPHRASE, fx.state)
  })
  afterEach(() => fx.cleanup())

  const config = (commands: unknown[]) =>
    GatesConfigSchema.parse({ commands, security: { gitleaks: "off", osv: "off" } })

  test("a required gate run halts without bubblewrap and runs nothing", async () => {
    const cfg = config([{ id: "probe", kind: "test", command: "touch RAN" }])
    const { hash, lines } = await commandSetHash(fx.root, cfg.commands)
    await trustProject(fx.root, hash, lines, { stateDir: fx.state, signer })
    resetBwrapProbe(false)
    try {
      const report = await runGates({
        root: fx.root,
        scope: "full",
        config: cfg,
        sandbox: "required",
        stateDir: fx.state,
      })
      expect(report.passed).toBe(false)
      expect(report.findings.map((finding) => finding.rule)).toContain("gates/sandbox-missing")
      expect(report.findings[0]?.message).toContain("bubblewrap")
      expect(await Bun.file(path.join(fx.root, "RAN")).exists()).toBe(false)
    } finally {
      resetBwrapProbe()
    }
  })

  test("a preferred gate run still runs without bubblewrap (user and human runs)", async () => {
    const cfg = config([{ id: "probe", kind: "test", command: "touch RAN-PREFERRED" }])
    const { hash, lines } = await commandSetHash(fx.root, cfg.commands)
    await trustProject(fx.root, hash, lines, { stateDir: fx.state, signer })
    resetBwrapProbe(false)
    try {
      const report = await runGates({
        root: fx.root,
        scope: "full",
        config: cfg,
        sandbox: "preferred",
        stateDir: fx.state,
      })
      expect(report.checks.find((check) => check.id === "probe")?.status).toBe("pass")
      expect(await Bun.file(path.join(fx.root, "RAN-PREFERRED")).exists()).toBe(true)
    } finally {
      resetBwrapProbe()
    }
  })
})
