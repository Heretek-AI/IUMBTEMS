// SessionStart fork wiring (#289): the host emits `session.forked` (a forked
// session is a new session inheriting its parent's history), so the bridge
// must fire engine.sessionStart(..., "fork") for it — otherwise hooks
// filtered to `fork` sit inert with only an engine notice. Resume/clear have
// no host bus events (see the engine notice pinned in core's hooks.test.ts),
// so they stay intentionally unsupported.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  commandSetHash,
  HookEngine,
  type HumanSigner,
  loadGatesConfig,
  sealHumanKey,
  trustProject,
  unlockHumanKey,
} from "@heretek-ai/es-core"
import { createHookBridge, type HookBridge } from "../src/hooks.ts"
import { createRuntime, parseOptions, type Runtime } from "../src/runtime.ts"

const hooks = {
  SessionStart: [
    {
      matcher: "fork",
      hooks: [{ type: "command", command: `touch "$CLAUDE_PROJECT_DIR/FORK_289"; echo FORK-MARKER-289` }],
    },
    {
      matcher: "startup",
      hooks: [{ type: "command", command: `touch "$CLAUDE_PROJECT_DIR/STARTUP_289"; echo STARTUP-MARKER-289` }],
    },
  ],
}

const stubCtx = {
  generate: { text: async () => ({ text: "" }) },
  session: {
    prompt: async () => ({}),
    context: async () => [],
    interrupt: async () => ({}),
  },
}

let root: string
let state: string
let runtime: Runtime
let bridge: HookBridge

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-fork-289-"))
  state = await mkdtemp(path.join(tmpdir(), "es-fork-289-state-"))
  await mkdir(path.join(root, ".claude"), { recursive: true })
  await writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks }))
  await sealHumanKey("test-passphrase-289", state)
  const signer: HumanSigner = await unlockHumanKey("test-passphrase-289", state)
  const { config } = await loadGatesConfig(root)
  const gates = await commandSetHash(root, config.commands)
  await trustProject(root, gates.hash, gates.lines, { stateDir: state, signer })
  const status = (await HookEngine.create({ root, stateDir: state, audit: false })).status()
  if (status.projectHash)
    await trustProject(root, status.projectHash, status.projectLines, {
      stateDir: state,
      kind: "hooks",
      signer,
    })
  runtime = await createRuntime(root, parseOptions({ stateDir: state }))
  bridge = await createHookBridge(stubCtx as never, runtime, () => [])
})

afterEach(async () => {
  await runtime.lsp.stopAll().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const agentOf = async () => "build"

describe("session.forked fires SessionStart with source fork (#289)", () => {
  test("a fork hook runs and its context is stashed for the forked session", async () => {
    await bridge.onEvent(
      { type: "session.forked", data: { sessionID: "s-fork-289", parentID: "s-parent-289" } },
      agentOf,
    )
    expect(await Bun.file(path.join(root, "FORK_289")).exists()).toBe(true)
    const event = { sessionID: "s-fork-289", agent: "build", system: [] as unknown[] }
    await bridge.context(event as never)
    expect(event.system).toHaveLength(1)
    expect((event.system[0] as { text: string }).text).toContain("FORK-MARKER-289")
  })

  test("the forked session does not refire startup on its first prompt", async () => {
    await bridge.onEvent(
      { type: "session.forked", data: { sessionID: "s-fork-289", parentID: "s-parent-289" } },
      agentOf,
    )
    await bridge.prompt({ sessionID: "s-fork-289", prompt: { text: "hi" } }, "build")
    // The fork already ran SessionStart; a genuinely new session still fires it.
    expect(await Bun.file(path.join(root, "STARTUP_289")).exists()).toBe(false)
    await bridge.prompt({ sessionID: "s-fresh-289", prompt: { text: "hi" } }, "build")
    expect(await Bun.file(path.join(root, "STARTUP_289")).exists()).toBe(true)
  })
})
