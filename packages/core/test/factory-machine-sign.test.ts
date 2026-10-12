// Machine-signed stage exits, ADR 0004 (#344).
// The factory's GRILL and SPEC exits accept a machine-signed transition
// (signStageTransition + verifyMachineTransition) on integration/* and
// factory/* branches with a green GateProofBundle; main, releases and every
// human-only operation stay refused. Real git repos, real factory runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createMachineKeyStore,
  type GateProofBundle,
  type MachineTransitionApproval,
  signStageTransition,
} from "../src/approval/machine.ts"
import { verifyApproval } from "../src/approval/record.ts"
import { Factory, type GateRequest, type GateRunLike } from "../src/factory/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { writeJson } from "../src/util/fs.ts"
import { run } from "../src/util/proc.ts"
import * as Git from "../src/worktree/git.ts"
import { type Fixture, frontier, gitRepo, writeReport, writeSpecs } from "./helpers.ts"

let fx: Fixture
let nextGate: GateRunLike
const gates = async (_request: GateRequest) => nextGate
const greenGate: GateRunLike = { passed: true, findings: [], summary: "green" }

const git = (root: string, ...args: string[]) => run(["git", ...args], { cwd: root })

beforeEach(async () => {
  fx = await gitRepo()
  nextGate = greenGate
  await git(fx.root, "checkout", "-q", "-b", "integration/w4-s4a")
})
afterEach(() => fx.cleanup())

const make = (overrides: Partial<ConstructorParameters<typeof Factory>[1]> = {}) =>
  new Factory(fx.root, { gates, stateDir: fx.state, ...overrides })

const greenProof = async (branch: string, overrides: Partial<GateProofBundle> = {}): Promise<GateProofBundle> => ({
  tiers: {
    tier1: { passed: 120, total: 120 },
    tier2: { passed: 48, total: 48 },
    tier3: { passed: 12, total: 12 },
  },
  unwaivedSecrets: 0,
  unwaivedVulnerabilities: 0,
  specsVerified: true,
  schemasVerified: true,
  commit: await Git.headCommit(fx.root),
  branch,
  ...overrides,
})

const signFor = (
  store: ReturnType<typeof createMachineKeyStore>,
  branch: string,
  stage: string,
  proof: GateProofBundle,
): MachineTransitionApproval =>
  signStageTransition(store, {
    branch,
    target: branch,
    kind: "stage-transition",
    stage,
    proof,
  })

/** A GRILL run with a settled frontier, ready for M1. */
async function atGrill(factory: Factory) {
  await factory.begin("human:tester")
  await factory.writeFrontier("grill", frontier())
}

/** A SPEC run through the machine M1 exit, ready for M2. */
async function atSpec(factory: Factory, branch: string) {
  await atGrill(factory)
  const store = createMachineKeyStore()
  const proof = await greenProof(branch)
  const record = signStageTransition(store, {
    branch,
    target: branch,
    kind: "stage-transition",
    stage: "GRILL",
    proof,
  })
  await factory.beginResearchWithMachine({ record, publicKeyPem: store.publicKeyPem, ceilingUSD: 5 })
  await writeReport(fx.root, fx.state)
  await factory.completeResearch("factory")
  await writeSpecs(fx.root, ["alpha"])
}

describe("M1: GRILL → RESEARCH with a machine signature (ADR 0004)", () => {
  test("a green proof on an in-scope branch exits GRILL, sets the human ceiling, audits as machine", async () => {
    const factory = make()
    await atGrill(factory)
    // A stale frontier wait is satisfied by the machine exit, like approveStage clears it.
    await writeJson(factoryLayout(fx.root).pending, [{ stage: "frontier", requestedBy: "grill", at: "x" }])
    const store = createMachineKeyStore()
    const proof = await greenProof("integration/w4-s4a")
    const record = signFor(store, "integration/w4-s4a", "GRILL", proof)
    const state = await factory.beginResearchWithMachine({
      record,
      publicKeyPem: store.publicKeyPem,
      ceilingUSD: 5,
    })
    expect(state.stage).toBe("RESEARCH")
    expect(state.spendCeilingUSD).toBe(5)
    const pending = JSON.parse(await Bun.file(factoryLayout(fx.root).pending).text())
    expect(pending).toEqual([])
  })

  test("C12: no machine exit without a positive human-set ceiling", async () => {
    const factory = make()
    await atGrill(factory)
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "GRILL", await greenProof("integration/w4-s4a"))
    await expect(
      factory.beginResearchWithMachine({ record, publicKeyPem: store.publicKeyPem, ceilingUSD: 0 }),
    ).rejects.toThrow(/spend ceiling/i)
    await expect(
      factory.beginResearchWithMachine({ record, publicKeyPem: store.publicKeyPem, ceilingUSD: Number.NaN }),
    ).rejects.toThrow(/spend ceiling/i)
    expect((await factory.read())!.stage).toBe("GRILL")
  })

  test("the machine never skips the grill: no settled frontier, no exit", async () => {
    const factory = make()
    await factory.begin("human:tester")
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "GRILL", await greenProof("integration/w4-s4a"))
    await expect(
      factory.beginResearchWithMachine({ record, publicKeyPem: store.publicKeyPem, ceilingUSD: 5 }),
    ).rejects.toThrow(/grill/i)
    expect((await factory.read())!.stage).toBe("GRILL")
  })

  test("C1: a main checkout is refused (stays human-only)", async () => {
    const factory = make()
    await atGrill(factory)
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "GRILL", await greenProof("integration/w4-s4a"))
    // The record is valid, but the run's checkout is main: the branch binding refuses.
    await git(fx.root, "checkout", "-q", "main")
    await expect(
      factory.beginResearchWithMachine({ record, publicKeyPem: store.publicKeyPem, ceilingUSD: 5 }),
    ).rejects.toThrow(/human-only|main|scope|match/i)
    expect((await factory.read())!.stage).toBe("GRILL")
  })

  test("C11: an opened audit still blocks the machine exit", async () => {
    const factory = make()
    await factory.openAudit("human:tester", { kind: "path", path: "README.md" }, { ceilingUSD: 5 })
    await factory.writeFrontier("grill", frontier())
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "GRILL", await greenProof("integration/w4-s4a"))
    await expect(
      factory.beginResearchWithMachine({ record, publicKeyPem: store.publicKeyPem, ceilingUSD: 5 }),
    ).rejects.toThrow(/code audit/i)
    expect((await factory.read())!.stage).toBe("GRILL")
  })

  test("C9: a machine record planted as a human approval buys nothing", async () => {
    const factory = make()
    await atGrill(factory)
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "GRILL", await greenProof("integration/w4-s4a"))
    await Bun.write(factoryLayout(fx.root).approval("frontier"), JSON.stringify(record))
    expect((await verifyApproval(fx.root, "frontier", { stateDir: fx.state })).ok).toBe(false)
    await expect(factory.beginResearch("human:tester")).rejects.toThrow()
    expect((await factory.read())!.stage).toBe("GRILL")
  })
})

describe("M2: SPEC → BUILD with a machine signature (ADR 0004)", () => {
  test("a green proof on an in-scope branch starts the build and binds specs from disk", async () => {
    const factory = make()
    await atSpec(factory, "integration/w4-s4a")
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "SPEC", await greenProof("integration/w4-s4a"))
    const state = await factory.startBuildWithMachine({ record, publicKeyPem: store.publicKeyPem })
    expect(state.stage).toBe("BUILD")
    expect(state.phases.map((phase) => phase.id)).toEqual(["alpha"])
    expect(state.runBranch).toMatch(/^factory\//)
    // goalHash is bound from the validated on-disk bytes, so a later edit is still caught.
    const goalHash = state.phases[0]!.goalHash
    expect(goalHash).toMatch(/^[0-9a-f]{64}$/)
    await writeFile(path.join(fx.root, ".factory/specs/alpha/GOAL.md"), "# edited\n")
    await expect(factory.complete("es-programmer")).rejects.toThrow()
  })

  test("C2/C3: release-merge and main-target records are refused (re-bound under a valid signature)", async () => {
    const factory = make()
    await atSpec(factory, "integration/w4-s4a")
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "SPEC", await greenProof("integration/w4-s4a"))
    await expect(
      factory.startBuildWithMachine({
        record: { ...record, kind: "release-merge" },
        publicKeyPem: store.publicKeyPem,
      }),
    ).rejects.toThrow(/human-only/i)
    await expect(
      factory.startBuildWithMachine({
        record: { ...record, target: "main" },
        publicKeyPem: store.publicKeyPem,
      }),
    ).rejects.toThrow(/human-only|refused/i)
    expect((await factory.read())!.stage).toBe("SPEC")
  })

  test("a record for the wrong exit is refused (GRILL record cannot start the build)", async () => {
    const factory = make()
    await atSpec(factory, "integration/w4-s4a")
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "GRILL", await greenProof("integration/w4-s4a"))
    await expect(factory.startBuildWithMachine({ record, publicKeyPem: store.publicKeyPem })).rejects.toThrow(/SPEC/i)
    // And a SPEC record cannot exit GRILL (separate run: one run, one stage).
    const fx2 = await gitRepo()
    try {
      await git(fx2.root, "checkout", "-q", "-b", "integration/other")
      const other = new Factory(fx2.root, { gates, stateDir: fx2.state })
      await other.begin("human:tester")
      await other.writeFrontier("grill", frontier())
      const tip = await Git.headCommit(fx2.root)
      const specRecord = signStageTransition(store, {
        branch: "integration/other",
        target: "integration/other",
        kind: "stage-transition",
        stage: "SPEC",
        proof: await greenProof("integration/w4-s4a", { branch: "integration/other", commit: tip }),
      })
      await expect(
        other.beginResearchWithMachine({ record: specRecord, publicKeyPem: store.publicKeyPem, ceilingUSD: 5 }),
      ).rejects.toThrow(/GRILL/i)
    } finally {
      await fx2.cleanup()
    }
  })

  test("C4: every red-proof class is refused at the factory gate (tampered under a valid signature)", async () => {
    const factory = make()
    await atSpec(factory, "integration/w4-s4a")
    const store = createMachineKeyStore()
    const base = signFor(store, "integration/w4-s4a", "SPEC", await greenProof("integration/w4-s4a"))
    const tampered: Array<[string, GateProofBundle]> = [
      [
        "failing tier",
        await greenProof("integration/w4-s4a", {
          tiers: {
            tier1: { passed: 119, total: 120 },
            tier2: { passed: 48, total: 48 },
            tier3: { passed: 12, total: 12 },
          },
        }),
      ],
      [
        "zero-total tier",
        await greenProof("integration/w4-s4a", {
          tiers: { tier1: { passed: 0, total: 0 }, tier2: { passed: 48, total: 48 }, tier3: { passed: 12, total: 12 } },
        }),
      ],
      ["un-waived secret", await greenProof("integration/w4-s4a", { unwaivedSecrets: 1 })],
      ["un-waived vulnerability", await greenProof("integration/w4-s4a", { unwaivedVulnerabilities: 2 })],
      ["unverified specs", await greenProof("integration/w4-s4a", { specsVerified: false })],
      ["unverified schemas", await greenProof("integration/w4-s4a", { schemasVerified: false })],
    ]
    for (const [name, proof] of tampered) {
      await expect(
        factory.startBuildWithMachine({
          record: { ...base, proof },
          publicKeyPem: store.publicKeyPem,
        }),
        name,
      ).rejects.toThrow(/machine.*refus|does not satisfy|human-only/i)
    }
    expect((await factory.read())!.stage).toBe("SPEC")
  })

  test("C5/C6/C7: forged, cross-branch and cross-commit records are refused with state unchanged", async () => {
    const factory = make()
    await atSpec(factory, "integration/w4-s4a")
    const store = createMachineKeyStore()
    const record = signFor(store, "integration/w4-s4a", "SPEC", await greenProof("integration/w4-s4a"))
    const other = createMachineKeyStore()
    // Another key's signature.
    await expect(factory.startBuildWithMachine({ record, publicKeyPem: other.publicKeyPem })).rejects.toThrow(/refus/i)
    // Re-bound to another in-scope branch.
    await expect(
      factory.startBuildWithMachine({
        record: { ...record, branch: "integration/other" },
        publicKeyPem: store.publicKeyPem,
      }),
    ).rejects.toThrow(/refus|does not match/i)
    // Re-bound to another commit.
    const tip = await greenProof("integration/w4-s4a")
    await expect(
      factory.startBuildWithMachine({
        record: { ...record, proof: { ...tip, commit: "b".repeat(40) } },
        publicKeyPem: store.publicKeyPem,
      }),
    ).rejects.toThrow(/refus/i)
    expect((await factory.read())!.stage).toBe("SPEC")
    expect((await factory.read())!.phases).toEqual([])
  })

  test("C10: an untrusted gate command set still refuses under a valid machine record", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-fx-trust-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-fx-trust-state-"))
    try {
      await git(dir, "init", "-q", "-b", "main")
      await writeFile(path.join(dir, "README.md"), "# x\n")
      await git(dir, "add", "-A")
      await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
      await git(dir, "checkout", "-q", "-b", "integration/trust")
      const trusted = new Factory(dir, { gates, stateDir: state })
      await trusted.begin("human:tester")
      const { frontier: fxFrontier, writeReport: fxReport, writeSpecs: fxSpecs } = await import("./helpers.ts")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(path.join(dir, ".factory"), { recursive: true })
      await writeFile(
        path.join(dir, ".factory/gates.json"),
        JSON.stringify({ commands: [{ id: "unit", kind: "test", command: "bun test" }] }),
      )
      await trusted.writeFrontier("grill", fxFrontier())
      const store = createMachineKeyStore()
      const branch = "integration/trust"
      const tip = (await run(["git", "rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
      const proof: GateProofBundle = {
        tiers: { tier1: { passed: 1, total: 1 }, tier2: { passed: 1, total: 1 }, tier3: { passed: 1, total: 1 } },
        unwaivedSecrets: 0,
        unwaivedVulnerabilities: 0,
        specsVerified: true,
        schemasVerified: true,
        commit: tip,
        branch,
      }
      await trusted.beginResearchWithMachine({
        record: signStageTransition(store, { branch, target: branch, kind: "stage-transition", stage: "GRILL", proof }),
        publicKeyPem: store.publicKeyPem,
        ceilingUSD: 5,
      })
      await fxReport(dir, state)
      await trusted.completeResearch("factory")
      await fxSpecs(dir, ["alpha"])
      await expect(
        trusted.startBuildWithMachine({
          record: signStageTransition(store, {
            branch,
            target: branch,
            kind: "stage-transition",
            stage: "SPEC",
            proof,
          }),
          publicKeyPem: store.publicKeyPem,
        }),
      ).rejects.toThrow(/waiting on you: trust/i)
      expect((await trusted.read())!.stage).toBe("SPEC")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("C14/B1: no tip check at this layer — a record for an older commit still exits (boundary, see #345)", async () => {
    const factory = make()
    await atGrill(factory)
    const store = createMachineKeyStore()
    const branch = "integration/w4-s4a"
    const oldTip = await Git.headCommit(fx.root)
    // Advance the branch tip after the proof was bound.
    await writeFile(path.join(fx.root, "later.txt"), "later\n")
    await git(fx.root, "add", "-A")
    await git(fx.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "later")
    expect(await Git.headCommit(fx.root)).not.toBe(oldTip)
    const record = signStageTransition(store, {
      branch,
      target: branch,
      kind: "stage-transition",
      stage: "GRILL",
      proof: await greenProof(branch, { commit: oldTip }),
    })
    // Accepted here by design: tip-vs-proof equality is enforced by
    // landOnStaging, not by stage exits (ADR 0004 boundary B1).
    const state = await factory.beginResearchWithMachine({
      record,
      publicKeyPem: store.publicKeyPem,
      ceilingUSD: 5,
    })
    expect(state.stage).toBe("RESEARCH")
  })
})
