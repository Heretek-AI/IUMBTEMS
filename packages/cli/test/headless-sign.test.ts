// Machine-signed stage transitions in the headless runner, ADR 0004 (#344).
// attemptMachineStageTransition passes allowed exits with a machine signature
// and a gate proof on integration/*/factory/* branches; main, detached and
// release transitions are refused with state untouched. An opt-in proof
// supplier lets a headless run move through the allowed exits and stop where
// a human is needed. Real git repos, real factory runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, type FactoryState, factoryLayout, type GateProofBundle, gateRunner } from "@heretek-ai/es-core"
import { attemptMachineStageTransition, type HarnessDriver, type HeadlessEvent, runHeadless } from "../src/headless.ts"

let root: string
let state: string
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}
const headCommit = async (): Promise<string> => {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" })
  return (await new Response(proc.stdout).text()).trim()
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-headless-sign-"))
  state = await mkdtemp(path.join(tmpdir(), "es-headless-sign-state-"))
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# x\n")
  await git("add", "-A")
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  await git("checkout", "-q", "-b", "integration/sign")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const factory = () => new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })

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
  commit: await headCommit(),
  branch,
  ...overrides,
})

const settledFrontier = () => ({
  version: "1.1",
  idea: "A greeting library",
  spendCeiling: { currency: "USD", maxAmount: 25 },
  settled: true,
  nodes: [{ id: "lang", question: "Language?", answer: "TypeScript", status: "settled" }],
})

async function atGrill() {
  const fx = factory()
  await fx.begin("human:tester")
  await fx.writeFrontier("grill", settledFrontier())
}

const idleDriver: HarnessDriver = {
  id: "fake",
  available: async () => true,
  async *turn() {
    yield { text: "working" }
    return "ses_fake"
  },
}

describe("attemptMachineStageTransition (ADR 0004)", () => {
  test("C1/H happy path: GRILL exits on integration/* with a machine signature and a gate proof", async () => {
    await atGrill()
    const proof = await greenProof("integration/sign")
    const after = await attemptMachineStageTransition(
      root,
      { transition: "GRILL", proof, ceilingUSD: 5 },
      { stateDir: state },
    )
    expect(after.stage).toBe("RESEARCH")
    expect(after.spendCeilingUSD).toBe(5)
  })

  test("C1/H: the same run on main is refused with state untouched", async () => {
    await git("checkout", "-q", "main")
    await atGrill()
    const proof = await greenProof("main")
    await expect(
      attemptMachineStageTransition(root, { transition: "GRILL", proof, ceilingUSD: 5 }, { stateDir: state }),
    ).rejects.toThrow(/human-only|scope|main/i)
    expect((await factory().read())!.stage).toBe("GRILL")
  })

  test("a detached checkout is refused (runs must be attributable to a branch)", async () => {
    await atGrill()
    await git("checkout", "-q", "--detach", "HEAD")
    const proof = await greenProof("integration/sign")
    await expect(
      attemptMachineStageTransition(root, { transition: "GRILL", proof, ceilingUSD: 5 }, { stateDir: state }),
    ).rejects.toThrow(/branch|detach|attributable/i)
    expect((await factory().read())!.stage).toBe("GRILL")
  })

  test("C2/H: a release transition is refused without touching state", async () => {
    await atGrill()
    const proof = await greenProof("integration/sign")
    await expect(
      attemptMachineStageTransition(root, { transition: "RELEASE", proof }, { stateDir: state }),
    ).rejects.toThrow(/human-only|release/i)
    expect((await factory().read())!.stage).toBe("GRILL")
  })

  test("C4/H: a red proof never mints (sign throws, state untouched)", async () => {
    await atGrill()
    const proof = await greenProof("integration/sign", { unwaivedSecrets: 3 })
    await expect(
      attemptMachineStageTransition(root, { transition: "GRILL", proof, ceilingUSD: 5 }, { stateDir: state }),
    ).rejects.toThrow(/secret/i)
    expect((await factory().read())!.stage).toBe("GRILL")
  })

  test("C12/H: GRILL needs the human-set ceiling", async () => {
    await atGrill()
    const proof = await greenProof("integration/sign")
    await expect(
      attemptMachineStageTransition(root, { transition: "GRILL", proof }, { stateDir: state }),
    ).rejects.toThrow(/ceiling/i)
    expect((await factory().read())!.stage).toBe("GRILL")
  })

  test("B2/H: every attempt mints under a fresh key (audited machine actors differ)", async () => {
    await atGrill()
    const first = await attemptMachineStageTransition(
      root,
      { transition: "GRILL", proof: await greenProof("integration/sign"), ceilingUSD: 5 },
      { stateDir: state },
    )
    expect(first.stage).toBe("RESEARCH")
    const lines = (await Bun.file(factoryLayout(root).audit).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const exits = lines.filter((entry) => entry.action === "stage.research")
    expect(exits.length).toBeGreaterThan(0)
    const actor = exits.at(-1)!.actor as string
    expect(actor.startsWith("machine:")).toBe(true)
    // The key is gone with the attempt: no API re-opens it, and the next
    // attempt (after re-grilling is out of scope here) would mint anew.
    expect(actor).not.toMatch(/^human:/)
  })
})

describe("runHeadless with a machine proof supplier (ADR 0004)", () => {
  async function pendingFrontier() {
    await mkdir(factoryLayout(root).runtime, { recursive: true })
    await writeFile(factoryLayout(root).pending, JSON.stringify([{ stage: "frontier", requestedBy: "grill", at: "x" }]))
  }

  const supplier = (branch: string) => ({
    ceilingUSD: 5,
    proofFor: async (stage: "frontier" | "spec", _state: FactoryState) => {
      if (stage !== "frontier") return undefined
      return greenProof(branch)
    },
  })

  test("a headless run on integration/* moves through GRILL on a machine signature, then keeps driving", async () => {
    await atGrill()
    await pendingFrontier()
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver: idleDriver,
      maxTurns: 1,
      stallTurns: 99,
      stateDir: state,
      machine: supplier("integration/sign"),
    }))
      events.push(event)
    // No human passphrase was ever needed: the run left GRILL on the machine exit.
    expect((await factory().read())!.stage).toBe("RESEARCH")
    expect(events.some((event) => event.type === "waiting")).toBe(false)
    expect(events.at(0)).toMatchObject({ type: "start" })
  })

  test("without a supplier the same run waits on a human (behaviour unchanged)", async () => {
    await atGrill()
    await pendingFrontier()
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({ root, driver: idleDriver, maxTurns: 1, stallTurns: 99, stateDir: state }))
      events.push(event)
    expect((await factory().read())!.stage).toBe("GRILL")
    expect(events.at(-1)).toMatchObject({ type: "waiting", stages: ["frontier"] })
  })

  test("on main the run waits on a human even with a supplier (refused, C13/H)", async () => {
    await git("checkout", "-q", "main")
    await atGrill()
    await pendingFrontier()
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver: idleDriver,
      maxTurns: 1,
      stallTurns: 99,
      stateDir: state,
      machine: supplier("main"),
    }))
      events.push(event)
    expect((await factory().read())!.stage).toBe("GRILL")
    expect(events.at(-1)).toMatchObject({ type: "waiting" })
  })

  test("a red proof from the supplier buys nothing: the run waits on a human", async () => {
    await atGrill()
    await pendingFrontier()
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver: idleDriver,
      maxTurns: 1,
      stallTurns: 99,
      stateDir: state,
      machine: {
        ceilingUSD: 5,
        proofFor: async () => greenProof("integration/sign", { unwaivedVulnerabilities: 1 }),
      },
    }))
      events.push(event)
    expect((await factory().read())!.stage).toBe("GRILL")
    expect(events.at(-1)).toMatchObject({ type: "waiting" })
  })
})
