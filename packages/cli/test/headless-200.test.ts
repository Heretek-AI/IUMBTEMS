// Headless factory runs (#200 §2): integration tests against the real
// in-process OpenCode v2 host (packages/testkit), plus the cheap proof gaps
// from bug #247. Spend-bearing seams are never touched: no `factory run
// --headless` launch, no real signals, no real harness binary. Everything
// here drives `runHeadless`/`driveHeadless` with fake in-process drivers
// (one of them forwarding prompts to the testkit host), scripted
// AbortControllers, pipe CLI runs that assert refusal codes, and a stub
// `opencode` binary for argv capture.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  exists,
  Factory,
  factoryLayout,
  gateRunner,
  readApproval,
  researchSourcesDir,
  SourceCache,
  sealHumanKey,
  stringifyFrontmatter,
} from "@heretek-ai/es-core"
import type { Harness } from "../../testkit/src/host.ts"
import { boot } from "../../testkit/src/host.ts"
import { directiveScript } from "../../testkit/src/script.ts"
import {
  DRIVERS,
  type DriverTurn,
  driveHeadless,
  type HarnessDriver,
  type HeadlessEvent,
  headlessExitCode,
  opencodeDriver,
  runHeadless,
} from "../src/headless.ts"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

const PASSPHRASE = "test-passphrase-1234"

let root: string
let state: string
const realXdgConfig = process.env.XDG_CONFIG_HOME
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-200-"))
  state = await mkdtemp(path.join(tmpdir(), "es-200-state-"))
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

/** A human at a terminal who types the passphrase with echo off. */
const human = (answer: string = PASSPHRASE): ConfirmIO & { output: string[] } => {
  const output: string[] = []
  return {
    interactive: true,
    output,
    write: (text) => output.push(text),
    readLine: async () => "",
    readSecret: async () => answer,
  }
}
const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }

async function runCli(argv: string[], confirm: ConfirmIO = pipe) {
  const printed: string[] = []
  const code = await main(argv, { print: (text) => printed.push(text), confirm, cwd: root, stateDir: state })
  return { code, out: printed.join("\n") }
}

/** A settled grill, approved at a terminal: the run is in RESEARCH. */
async function researched() {
  const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
  await factory.writeFrontier("grill", {
    version: "1.1",
    idea: "cli test",
    spendCeiling: { currency: "USD", maxAmount: 5 },
    settled: true,
    nodes: [{ id: "a", question: "q?", answer: "yes", status: "settled" }],
  })
  const approved = await runCli(["approve", "frontier"], human())
  expect(approved.code).toBe(0)
  expect((await factory.read())?.stage).toBe("RESEARCH")
  return factory
}

describe("headless against the testkit host (#200 §2)", () => {
  let host: Harness | undefined

  beforeAll(async () => {
    host = await boot({ script: directiveScript })
  }, 60_000)
  afterAll(async () => {
    await host?.close()
    host = undefined
  })

  test("turns reach the real host; a pending approval stops the run without granting anything", async () => {
    const factory = await researched()
    const harness = host!
    const llmBefore = harness.llm.requests.length
    const calls: DriverTurn[] = []
    // The opencode driver seam: one turn carries the seat identity, the
    // prompt and the argv the harness CLI would get; here the harness is
    // the in-process testkit host instead of a spawned `opencode run`.
    const driver: HarnessDriver = {
      id: "fake-host",
      available: async () => true,
      async *turn(input: DriverTurn) {
        calls.push(input)
        const result = await harness.run(input.prompt)
        yield { type: "text", part: { text: `host settled ${result.context.length} messages` } }
        return result.sessionID
      },
    }
    // Phase 1: no pending approval, so the turn goes through the host.
    const first: HeadlessEvent[] = []
    for await (const event of runHeadless({ root, driver, maxTurns: 1, stallTurns: 99, stateDir: state }))
      first.push(event)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.agent).toBe("factory")
    expect(calls[0]?.prompt).toContain("headless run")
    expect(calls[0]?.root).toBe(root)
    expect(harness.llm.requests.length).toBeGreaterThan(llmBefore)
    expect(first.at(-1)).toEqual({ type: "turn-cap", turns: 1 })
    // Phase 2: a pending approval stops the run before any turn is driven.
    const pending = factoryLayout(root).pending
    await mkdir(path.dirname(pending), { recursive: true })
    await writeFile(pending, JSON.stringify([{ stage: "spec", requestedBy: "factory", at: "2026-10-10T00:00:00Z" }]))
    const pendingBefore = await readFile(pending, "utf8")
    const stageBefore = (await factory.read())?.stage
    const callsBefore = calls.length
    const llmMid = harness.llm.requests.length
    const second: HeadlessEvent[] = []
    for await (const event of runHeadless({ root, driver, maxTurns: 5, stallTurns: 99, stateDir: state }))
      second.push(event)
    expect(second.at(-1)).toEqual({
      type: "waiting",
      reason: "a human must approve (es approve <stage>)",
      stages: ["spec"],
    })
    // Nothing was granted: no new host turn, the pending file is byte
    // identical, the stage is unchanged, and no approval was recorded.
    expect(calls.length).toBe(callsBefore)
    expect(harness.llm.requests.length).toBe(llmMid)
    expect(await readFile(pending, "utf8")).toBe(pendingBefore)
    expect((await factory.read())?.stage).toBe(stageBefore)
    expect(await readApproval(root, "spec")).toBeUndefined()
  }, 60_000)
})

describe("headless proof gaps (#247)", () => {
  test("the driver sees the seat identity, the prompt, the model and the threaded session", async () => {
    await researched()
    const calls: DriverTurn[] = []
    let n = 0
    const driver: HarnessDriver = {
      id: "fake",
      available: async () => true,
      async *turn(input: DriverTurn) {
        calls.push(input)
        n++
        yield { text: "working" }
        return n === 1 ? "ses_1" : "ses_2"
      },
    }
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver,
      maxTurns: 2,
      stallTurns: 99,
      stateDir: state,
      model: "fake/scripted",
    }))
      events.push(event)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.agent).toBe("factory")
      expect(call.prompt).toContain("headless run")
      expect(call.root).toBe(root)
      expect(call.model).toBe("fake/scripted")
    }
    expect(calls[0]?.session).toBeUndefined()
    expect(calls[0]?.signal).toBeUndefined()
    // The first turn's session id is threaded into the second turn.
    expect(calls[1]?.session).toBe("ses_1")
    expect(events.at(-1)).toEqual({ type: "turn-cap", turns: 2 })
  })

  test("the opencode driver argv shape: run --standalone --format json --agent [--model] [--session] prompt", async () => {
    expect(opencodeDriver.id).toBe("opencode")
    expect(DRIVERS.opencode).toBe(opencodeDriver)
    const bin = await mkdtemp(path.join(tmpdir(), "es-argv-opencode-"))
    const capture = path.join(bin, "argv.jsonl")
    await writeFile(
      path.join(bin, "opencode"),
      `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs"\nappendFileSync(process.env.ES_ARGV_CAPTURE!, \`\${JSON.stringify(Bun.argv.slice(2))}\\n\`)\nconsole.log(JSON.stringify({ type: "text", sessionID: "ses_argv1", part: { text: "stub" } }))\n`,
    )
    await chmod(path.join(bin, "opencode"), 0o755)
    const previousPath = process.env.PATH
    const previousCapture = process.env.ES_ARGV_CAPTURE
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`
    process.env.ES_ARGV_CAPTURE = capture
    try {
      const turnArgv = async (input: DriverTurn) => {
        await rm(capture, { force: true })
        const seen: unknown[] = []
        const turn = opencodeDriver.turn(input)
        let step = await turn.next()
        while (!step.done) {
          seen.push(step.value)
          step = await turn.next()
        }
        const lines = (await readFile(capture, "utf8")).trim().split("\n")
        return { argv: JSON.parse(lines[0]!) as string[], events: seen, session: step.value }
      }
      const minimal = await turnArgv({ root, agent: "factory", prompt: "go" })
      expect(minimal.argv).toEqual(["run", "--standalone", "--format", "json", "--agent", "factory", "go"])
      expect(minimal.session).toBe("ses_argv1")
      expect(minimal.events).toHaveLength(1)
      const full = await turnArgv({
        root,
        agent: "factory",
        prompt: "go",
        model: "fake/scripted",
        session: "ses_prev",
      })
      expect(full.argv).toEqual([
        "run",
        "--standalone",
        "--format",
        "json",
        "--agent",
        "factory",
        "--model",
        "fake/scripted",
        "--session",
        "ses_prev",
        "go",
      ])
      // The prompt is always the trailing argument, after any seat flags.
      expect(full.argv.at(-1)).toBe("go")
    } finally {
      process.env.PATH = previousPath
      if (previousCapture === undefined) delete process.env.ES_ARGV_CAPTURE
      else process.env.ES_ARGV_CAPTURE = previousCapture
      await rm(bin, { recursive: true, force: true })
    }
    // With no harness binary on PATH the driver reports itself unavailable.
    const empty = await mkdtemp(path.join(tmpdir(), "es-argv-empty-"))
    try {
      process.env.PATH = empty
      expect(await opencodeDriver.available()).toBe(false)
    } finally {
      process.env.PATH = previousPath
      await rm(empty, { recursive: true, force: true })
    }
  })

  test("a scripted driver drives runHeadless to DONE and the prUrl spreads into done", async () => {
    const green = { passed: true, findings: [], summary: "green" }
    const stubGates = async () => green
    const factory = new Factory(root, { gates: stubGates, stateDir: state })
    await factory.writeFrontier("grill", {
      version: "1.1",
      idea: "cli test",
      spendCeiling: { currency: "USD", maxAmount: 5 },
      settled: true,
      nodes: [{ id: "a", question: "q?", answer: "yes", status: "settled" }],
    })
    expect((await runCli(["approve", "frontier"], human())).code).toBe(0)
    // A research report whose single claim cites a cached source verbatim.
    const cache = new SourceCache(researchSourcesDir(root), state)
    const source = await cache.put({
      url: "https://example.test/greeting",
      text: "Greeting libraries usually expose a single greet function.",
      provider: "fetch",
    })
    await mkdir(path.join(root, ".factory/research"), { recursive: true })
    await writeFile(
      path.join(root, ".factory/research/REPORT.md"),
      `# Research\n\n- A greet function is the conventional API [VERIFIED: sha256:${source.meta.sha256} "expose a single greet function"]\n`,
    )
    await factory.completeResearch("factory")
    await mkdir(path.join(root, ".factory/specs/alpha"), { recursive: true })
    await writeFile(
      path.join(root, ".factory/roadmap.json"),
      JSON.stringify({ version: 1, title: "Greeting", phases: [{ id: "alpha", title: "Phase alpha" }] }),
    )
    await writeFile(
      path.join(root, ".factory/specs/alpha/GOAL.md"),
      stringifyFrontmatter(
        {
          phase: "alpha",
          title: "Phase alpha",
          acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: "src/alpha.ts" }],
        },
        "Implement alpha as a vertical slice.\n",
      ),
    )
    expect((await runCli(["approve", "spec"], human())).code).toBe(0)
    await factory.startBuild("factory")
    const dir = (await factory.activeWorktree())!
    await mkdir(path.join(dir, "src"), { recursive: true })
    await mkdir(path.join(dir, "test"), { recursive: true })
    await writeFile(path.join(dir, "test/alpha.test.ts"), `test("alpha", () => {})\n`)
    await factory.recordGateRun("es-programmer", {
      passed: false,
      findings: [],
      summary: "red",
      failedTests: ["test/alpha.test.ts"],
    })
    await writeFile(path.join(dir, "src/alpha.ts"), "export const alpha = 1\n")
    expect((await factory.complete("es-programmer")).ok).toBe(true)
    await factory.qaVerdict("es-qa-functional", "pass", "ok")
    expect((await factory.qaVerdict("es-qa-adversarial", "pass", "ok")).stage).toBe("RELEASE")
    // The scripted turn records the PR (the human fallback): the next loop
    // sees DONE with a release, and done carries the prUrl.
    const prUrl = "https://example.test/pr/9"
    const calls: DriverTurn[] = []
    const driver: HarnessDriver = {
      id: "fake",
      available: async () => true,
      async *turn(input: DriverTurn) {
        calls.push(input)
        yield { text: "recording the pr" }
        await new Factory(root, { gates: stubGates, stateDir: state }).recordPr("tester", prUrl)
        return "ses_done"
      },
    }
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({ root, driver, maxTurns: 5, stallTurns: 99, stateDir: state }))
      events.push(event)
    expect(events[0]).toMatchObject({ type: "start" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.agent).toBe("factory")
    expect(events.at(-1)).toEqual({ type: "done", prUrl })
    expect((await factory.read())?.stage).toBe("DONE")
  })

  test("a STOP file halts at headless level: no turn runs, the stage is untouched", async () => {
    const factory = await researched()
    await writeFile(factoryLayout(root).stop, "lunch\n")
    let turns = 0
    const driver: HarnessDriver = {
      id: "fake",
      available: async () => true,
      async *turn() {
        turns++
        yield { text: "never" }
        return "ses_fake"
      },
    }
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({ root, driver, maxTurns: 3, stallTurns: 99, stateDir: state }))
      events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "halted", reason: expect.stringContaining("lunch") })
    expect(turns).toBe(0)
    expect((await factory.read())?.stage).toBe("RESEARCH")
    expect(await exists(factoryLayout(root).stop)).toBe(true)
  })

  test("an unknown --driver is refused before anything runs", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "es-200-empty-"))
    try {
      const printed: string[] = []
      const code = await main(["factory", "run", "--headless", "--driver", "nope"], {
        print: (text) => printed.push(text),
        confirm: pipe,
        cwd: empty,
        stateDir: state,
      })
      const out = printed.join("\n")
      expect(code).toBe(2)
      expect(out).toContain("Unknown driver")
      expect(out).toContain("opencode")
      expect(await exists(factoryLayout(empty).dir)).toBe(false)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test("exit codes: cancelled is 130, failures stay 1, the rest 0", async () => {
    expect(headlessExitCode("cancelled")).toBe(130)
    for (const type of ["error", "halted", "stalled", "turn-cap"] as const) expect(headlessExitCode(type)).toBe(1)
    for (const type of ["start", "turn", "driver", "progress", "turn-metrics", "waiting", "done"] as const)
      expect(headlessExitCode(type)).toBe(0)
  })

  test("a pre-aborted signal cancels at Abort level: no error, no halt, resumable", async () => {
    const factory = await researched()
    const hanging: HarnessDriver = {
      id: "hang",
      available: async () => true,
      async *turn() {
        await new Promise<never>(() => {})
        yield { text: "never" }
        return undefined
      },
    }
    const controller = new AbortController()
    controller.abort()
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver: hanging,
      maxTurns: 5,
      stateDir: state,
      signal: controller.signal,
      progressMs: 60_000,
    }))
      events.push(event)
    // No real signal was sent: the mapping (SIGINT/SIGTERM -> abort ->
    // `cancelled`, exit 130) is proven at the Abort level, and the live
    // signal E2E stays human-only (issue #200 §3, NEEDS HUMAN).
    expect(events.at(-1)).toMatchObject({
      type: "cancelled",
      reason: expect.stringContaining("run state is untouched"),
    })
    expect(headlessExitCode("cancelled")).toBe(130)
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect((await factory.read())?.stage).toBe("RESEARCH")
    expect(await exists(factoryLayout(root).stop)).toBe(false)
  })

  test("driveHeadless threads a custom job's done (with prUrl) through unchanged", async () => {
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    await factory.provisionRun("tester", 5)
    const prUrl = "https://example.test/pr/7"
    const driver: HarnessDriver = {
      id: "fake",
      available: async () => true,
      async *turn() {
        yield { text: "working" }
        return "ses_fake"
      },
    }
    const events: HeadlessEvent[] = []
    for await (const event of driveHeadless(
      { root, driver, maxTurns: 3, stallTurns: 99, stateDir: state },
      {
        agent: "factory",
        prompt: async () => "go",
        finished: async () => ({ type: "done", prUrl }),
        progress: async () => "p",
      },
    ))
      events.push(event)
    expect(events.at(-1)).toEqual({ type: "done", prUrl })
  })
})
