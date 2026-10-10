// Concurrent runtime-state writes hold the lock (issue #179, §2).
//
// Two concurrent es_qa_verdict tool calls (functional + adversarial) both
// persist — no torn JSON, no lost verdict — and two concurrent journal steps
// both land. State reads during the race never observe a half-signed
// (state, sidecar) pair: a refusal would reject the Promise.all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordApproval } from "../src/approval/index.ts"
import type { HumanSigner } from "../src/approval/keystore.ts"
import { sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { Factory } from "../src/factory/index.ts"
import { once, readJournal } from "../src/factory/journal.ts"
import { gateRunner } from "../src/gates/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { esTools } from "../src/ops/tools.ts"
import { type Fixture, frontier, gitRepo, writeReport, writeSpecs } from "./helpers.ts"

let fx: Fixture
let signer: HumanSigner
const green = { passed: true, findings: [], summary: "green" } as const
const gates = async () => green

beforeEach(async () => {
  fx = await gitRepo("es-stage-conc-")
  await sealHumanKey("test-passphrase-1234", fx.state)
  signer = await unlockHumanKey("test-passphrase-1234", fx.state)
})
afterEach(() => fx.cleanup())

const factory = () => new Factory(fx.root, { gates, stateDir: fx.state })
const approve = (stage: "frontier" | "spec") =>
  recordApproval(fx.root, { stage, channel: "cli", approvedBy: "tester", signer })

async function toQa() {
  const f = factory()
  await f.begin("human:tester")
  await f.writeFrontier("grill", frontier())
  await approve("frontier")
  await f.beginResearch("human:tester")
  await writeReport(fx.root, fx.state)
  await f.completeResearch("factory")
  await writeSpecs(fx.root, ["alpha"])
  await approve("spec")
  await f.startBuild("factory")
  const dir = (await f.activeWorktree())!
  const { mkdir, writeFile } = await import("node:fs/promises")
  await mkdir(path.join(dir, "src"), { recursive: true })
  await mkdir(path.join(dir, "test"), { recursive: true })
  await writeFile(path.join(dir, "test/alpha.test.ts"), `test("alpha", () => {})\n`)
  await f.recordGateRun("es-programmer", {
    passed: false,
    findings: [],
    summary: "red",
    failedTests: ["test/alpha.test.ts"],
  })
  await writeFile(path.join(dir, "src/alpha.ts"), `export const alpha = 1\n`)
  const done = await f.complete("es-programmer")
  expect(done.ok).toBe(true)
  expect((await f.read())!.stage).toBe("QA")
}

describe("concurrent runtime-state writes (issue #179)", () => {
  test("two concurrent es_qa_verdict tool calls both persist; reads stay sealed", async () => {
    await toQa()
    const f = factory()
    const tools = esTools({ root: fx.root, factory: f, stateDir: fx.state })
    const verdict = tools.find((tool) => tool.name === "es_qa_verdict")!
    const [functional, adversarial, seen] = await Promise.all([
      verdict.execute({ verdict: "pass", notes: "criteria met" }, { agent: "es-qa-functional" }),
      verdict.execute({ verdict: "pass", notes: "nothing broke" }, { agent: "es-qa-adversarial" }),
      f.read(),
    ])
    expect(typeof functional).toBe("string")
    expect(typeof adversarial).toBe("string")
    expect([functional, adversarial].some((text) => text.includes("RELEASE"))).toBe(true)
    // The concurrent read saw a sealed, parseable snapshot (never torn):
    // it may win the race (QA) or lose it (RELEASE); only progress matters.
    expect(["QA", "RELEASE"]).toContain(seen?.stage)
    const state = (await f.read())!
    expect([state.stage, state.phases[0]!.status]).toEqual(["RELEASE", "passed"])
    expect(state.phases[0]!.qa).toMatchObject({
      functional: { verdict: "pass" },
      adversarial: { verdict: "pass" },
    })
  })

  test("two concurrent journal steps both land, in full; spend races keep every event", async () => {
    await toQa()
    const f = factory()
    await Promise.all([
      once(fx.root, "concurrent-a", async () => ({ side: "a" })),
      once(fx.root, "concurrent-b", async () => ({ side: "b" })),
    ])
    const steps = (await readJournal(fx.root)).map((entry) => entry.step)
    expect(steps).toContain("concurrent-a")
    expect(steps).toContain("concurrent-b")

    // Concurrent spend charges never lose an event and never tear the file.
    await Promise.all([f.recordSpend(1, true), f.recordSpend(2, true), f.read(), f.read()])
    const state = (await f.read())!
    expect(state.spend.usd).toBe(3)
    expect(state.spend.events).toBe(2)
    // The sidecar still verifies after the race (read would throw otherwise).
    expect(state.stage).toBe("QA")
  })

  test("ten concurrent spend writes serialize without loss", async () => {
    await toQa()
    const f = factory()
    await Promise.all(Array.from({ length: 10 }, (_, i) => f.recordSpend(1, i % 2 === 0)))
    const state = (await f.read())!
    expect(state.spend.usd).toBe(10)
    expect(state.spend.events).toBe(10)
  })
})
