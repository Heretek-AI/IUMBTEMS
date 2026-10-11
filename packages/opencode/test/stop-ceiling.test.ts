// STOP halt and mandatory spend ceiling on the real host (#184): a scripted
// fake LLM reporting cost per step drives the run into its ceiling, and a
// STOP file created mid-run refuses the next es_* call and the next seat
// launch. Agents can neither create nor remove STOP (bug #229 proof gap).
//
// Real in-process OpenCode v2 host via packages/testkit (scripted fake LLM);
// must pass pinned and under scripts/v2-head.sh.
//
// Not covered here by design: the MCP surface executes esTools with no STOP
// gate and a non-seat (user-agent) `subagent` launch bypasses STOP/HALTED
// (both filed as bug #227) — the seat-launch refusal below uses a factory
// seat, the guarded path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, factoryLayout, gateRunner } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness, type Script } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const stopOf = (h: Harness) => path.join(h.directory, ".factory/STOP")
const exists = (file: string) => Bun.file(file).exists()

async function bootHost(prefix: string, script: Script = directiveScript) {
  const state = await mkdtemp(path.join(tmpdir(), prefix))
  const h = await boot({
    git: true,
    script,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# stop ceiling\n" },
  })
  const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
  return { state, h, factory }
}

// Per-step cost the fake LLM reports, in USD, under the tracker's default
// estimate rates (packages/opencode/src/session.ts: inputPerM 3,
// outputPerM 15): every host step records exactly this estimate.
const STEP_INPUT_TOKENS = 20_000
const STEP_OUTPUT_TOKENS = 10_000
const STEP_COST_USD = (STEP_INPUT_TOKENS * 3 + STEP_OUTPUT_TOKENS * 15) / 1_000_000
const costly: Script = (request) => ({
  ...directiveScript(request),
  usage: { input: STEP_INPUT_TOKENS, output: STEP_OUTPUT_TOKENS },
})

describe("the spend ceiling halts a real v2 run (#184)", () => {
  let h: Harness
  let state: string
  let factory: () => Factory
  beforeAll(async () => {
    ;({ h, state, factory } = await bootHost("es-stop-ceiling-", costly))
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("fake-LLM cost per step runs into the ceiling; halt names it; spend <= ceiling + one step", async () => {
    const CEILING = 0.5
    await factory().provisionRun("tester", CEILING)
    // Run until the brake engages (each run is a factory-agent session, so
    // every host step is estimated spend). Poll after each run: spend lands
    // through the async session.step.ended subscription.
    for (let i = 0; i < 10; i++) {
      await h.run(call("es_status"), { agent: "factory" })
      const start = Date.now()
      while ((await factory().read())?.stage !== "HALTED" && Date.now() - start < 5_000) await Bun.sleep(20)
      if ((await factory().read())?.stage === "HALTED") break
    }
    const halted = (await factory().read())!
    expect(halted.stage).toBe("HALTED")
    expect(halted.halt?.reason).toContain("spend ceiling reached")
    expect(halted.spend.estimated).toBe(true)
    // Breach overshoots by at most the step that crossed it.
    expect(halted.spend.usd).toBeGreaterThanOrEqual(CEILING)
    expect(halted.spend.usd).toBeLessThanOrEqual(CEILING + STEP_COST_USD + 1e-9)

    // The next es_* call is refused with the halt; status still reports.
    const refused = await h.run(call("es_build_start"), { agent: "factory" })
    expect(refused.tools[0]?.status).toBe("error")
    expect(refused.tools[0]?.text).toContain("halted")
    expect(refused.tools[0]?.text).toContain("spend ceiling reached")
    const stillThere = await h.run(call("es_status"), { agent: "factory" })
    expect(stillThere.tools[0]?.status).toBe("completed")
  }, 120_000)
})

describe("STOP created mid-run refuses the next es_* call and seat launch (#184)", () => {
  let h: Harness
  let state: string
  let factory: () => Factory
  beforeAll(async () => {
    ;({ h, state, factory } = await bootHost("es-stop-midrun-"))
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("next es_* call and next (factory-seat) launch are refused; spend bookkeeping halts too", async () => {
    await factory().provisionRun("tester", 10)
    const before = await h.run(call("es_status"), { agent: "factory" })
    expect(before.tools[0]?.status).toBe("completed")

    // A human creates STOP mid-run.
    await writeFile(stopOf(h), "audit halt")

    const tool = await h.run(call("es_gates_run", { scope: "full" }), { agent: "factory" })
    expect(tool.tools[0]?.status).toBe("error")
    expect(tool.tools[0]?.text).toContain("stopped")
    const launch = await h.run(
      call("subagent", { agent: "es-qa-functional", description: "qa", prompt: "check the build" }),
      { agent: "factory" },
    )
    expect(launch.tools[0]?.status).toBe("error")
    expect(launch.tools[0]?.text).toContain("stopped")

    // The user's own agent keeps working (read-only).
    const user = await h.run(call("read", { path: "README.md" }))
    expect(user.tools[0]?.status).toBe("completed")

    // Async spend bookkeeping observes the same brake and records the halt.
    const halted = await factory().recordSpend(0.001, true)
    expect(halted?.stage).toBe("HALTED")
    expect(halted?.halt?.reason).toContain("audit halt")

    await rm(stopOf(h))
  }, 120_000)
})

describe("agents can neither create nor remove STOP (#184, bug #229)", () => {
  let h: Harness
  let state: string
  beforeAll(async () => {
    ;({ h, state } = await bootHost("es-stop-delete-"))
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("write/edit/patch/shell attempts on .factory/STOP are denied", async () => {
    const stop = stopOf(h)
    // No STOP present: creation attempts are denied and nothing appears.
    const attempts = [
      call("write", { path: ".factory/STOP", content: "forged halt" }),
      call("edit", { path: ".factory/STOP", oldString: "x", newString: "y" }),
      call("patch", { patchText: "*** Begin Patch\n*** Add File: .factory/STOP\n+forged\n*** End Patch" }),
      call("shell", { command: "echo forged > .factory/STOP" }),
      call("shell", { command: "rm -f .factory/STOP" }),
    ]
    const { tools } = await h.run(`halt ${attempts.join(" ")}`)
    expect(tools).toHaveLength(attempts.length)
    for (const outcome of tools) expect(`${outcome.name}:${outcome.status}`).toBe(`${outcome.name}:error`)
    expect(await exists(stop)).toBe(false)

    // STOP present (human-written): overwrite and removal attempts are
    // denied — seats at the STOP gate, the user's agent at the control rule.
    await mkdir(path.dirname(stop), { recursive: true })
    await writeFile(stop, "hold")
    const layout = factoryLayout(h.directory)
    expect(layout.stop).toBe(stop)
    const seatWrite = await h.run(call("write", { path: ".factory/STOP", content: "released" }), {
      agent: "factory",
    })
    expect(seatWrite.tools[0]?.status).toBe("error")
    const userWrite = await h.run(call("write", { path: stop, content: "released" }))
    expect(userWrite.tools[0]?.status).toBe("error")
    const userRemove = await h.run(call("shell", { command: "rm .factory/STOP" }))
    expect(userRemove.tools[0]?.status).toBe("error")
    expect(await Bun.file(stop).text()).toBe("hold")
    await rm(stop)
  }, 120_000)
})
