// Issue #196 §2 — hook bridge on the real in-process OpenCode v2 host.
//
// One hook per event writes a marker file; the tests drive each event through
// the host (scripted fake LLM) and assert the marker landed. Complements
// packages/core/test/hooks-events.test.ts (engine-direct proof).
//
// NOTE (bug #265): hook commands run UNSANDBOXED with the full parent env
// (core run.ts: inheritEnv:true, no sandbox knob). The PRE_ENV_196 assertion
// pins that observable behaviour without changing it — Claude Code parity by
// design, not a sandbox.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
import { allText, boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const json = (value: unknown) => `echo '${JSON.stringify(value)}'`
const at = (name: string) => path.join(h.directory, name)
const exists = (name: string) => Bun.file(at(name)).exists()

// Parent-env probe (bug #265): visible inside every hook command.
const ENV_KEY = "ES_HOOK_PARENT_PROBE_196"
const ENV_VALUE = `probe-196-${Date.now()}`

const hooks = {
  PreToolUse: [
    {
      matcher: "Write",
      hooks: [
        {
          type: "command",
          // Always marks + records the parent env; denies only payloads carrying the canary.
          command: `touch "$CLAUDE_PROJECT_DIR/PRE_196"; echo "$${ENV_KEY}" > "$CLAUDE_PROJECT_DIR/PRE_ENV_196"; input=$(cat); echo "$input" | grep -q "deny-pre-196" && { echo "pre-deny-196 blocked" >&2; exit 2; }; exit 0`,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: "Read",
      hooks: [
        {
          type: "command",
          command: `touch "$CLAUDE_PROJECT_DIR/POST_196"; ${json({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "POST-MARKER-196" } })}`,
        },
      ],
    },
  ],
  PostToolUseFailure: [
    {
      matcher: "Read",
      hooks: [
        {
          type: "command",
          // Bug #268: this handler was routed but never proven — the failing-read
          // test below drives it through a real tool error.
          command: `touch "$CLAUDE_PROJECT_DIR/FAIL_196"; ${json({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "FAILURE-MARKER-196" } })}`,
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: "command",
          command: `touch "$CLAUDE_PROJECT_DIR/PROMPT_196"; echo PROMPT-MARKER-196`,
        },
      ],
    },
  ],
  SessionStart: [
    {
      matcher: "startup",
      hooks: [{ type: "command", command: `touch "$CLAUDE_PROJECT_DIR/START_196"; echo START-MARKER-196` }],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          // Marker only, no block: proves the emulated Stop hook ran after the
          // turn without re-prompting (ADVISORY for plain chat).
          command: `touch "$CLAUDE_PROJECT_DIR/STOP_196"; exit 0`,
        },
      ],
    },
  ],
  PermissionRequest: [
    {
      matcher: "Read",
      hooks: [
        {
          type: "command",
          // Runs only when the host would ask (effect ask — e.g. .env reads):
          // always marks, denies only .env payloads.
          command: `touch "$CLAUDE_PROJECT_DIR/PERM_196"; input=$(cat); echo "$input" | grep -q "\\.env" && ${json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "perm-deny-196 blocked" } } })} || ${json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })}`,
        },
      ],
    },
  ],
}

const extraHooks = {
  hooks: {
    "x-es.ShellPreExec": [
      {
        hooks: [
          {
            type: "command",
            // Bug #268: rewrite was proven, deny was not. Always marks; denies
            // *deny-shell-196*, rewrites *rewrite-shell-196*.
            command: `touch "$CLAUDE_PROJECT_DIR/SHELL_196"; input=$(cat); if echo "$input" | grep -q "deny-shell-196"; then ${json({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "shell-deny-196 blocked" } })}; elif echo "$input" | grep -q "rewrite-shell-196"; then ${json({ hookSpecificOutput: { updatedInput: { command: "echo shell-rewritten-196" } } })}; fi; true`,
          },
        ],
      },
    ],
  },
}

let state: string
let h: Harness

async function waitFor(name: string, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (await exists(name)) return true
    if (Date.now() - start > timeoutMs) return false
    await Bun.sleep(200)
  }
}

beforeAll(async () => {
  process.env[ENV_KEY] = ENV_VALUE
  state = await mkdtemp(path.join(tmpdir(), "es-hookbridge-ev-state-"))
  await sealHumanKey("test-passphrase-1234", state)
  const signer: HumanSigner = await unlockHumanKey("test-passphrase-1234", state)
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: {
      "README.md": "# hooks-events\n",
      ".env": "SECRET=1\n",
      ".claude/settings.json": JSON.stringify({ hooks }),
      ".opencode/hooks.json": JSON.stringify(extraHooks),
    },
  })
  // Trust the project hook set through the human key, as hooks.test.ts does.
  const { config } = await loadGatesConfig(h.directory)
  const gates = await commandSetHash(h.directory, config.commands)
  const status = (await HookEngine.create({ root: h.directory, stateDir: state, audit: false })).status()
  await trustProject(h.directory, gates.hash, gates.lines, { stateDir: state, signer })
  if (status.projectHash)
    await trustProject(h.directory, status.projectHash, status.projectLines, {
      stateDir: state,
      kind: "hooks",
      signer,
    })
}, 60_000)
afterAll(async () => {
  delete process.env[ENV_KEY]
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("hook bridge markers on the real host (issue #196 §2)", () => {
  test("SessionStart + UserPromptSubmit hooks mark every session", async () => {
    await h.run("hello marker run")
    expect(await exists("START_196")).toBe(true)
    expect(await exists("PROMPT_196")).toBe(true)
  })

  test("PreToolUse hook marks the write; parent env is visible unsandboxed (bug #265)", async () => {
    const { tools } = await h.run(call("write", { path: "ok-196.txt", content: "fine" }))
    expect(tools[0]?.status).toBe("completed")
    expect(await exists("PRE_196")).toBe(true)
    expect((await Bun.file(at("PRE_ENV_196")).text()).trim()).toBe(ENV_VALUE)
  })

  test("PreToolUse deny (exit 2) blocks the tool", async () => {
    const { tools } = await h.run(call("write", { path: "blocked-196.txt", content: "deny-pre-196 please" }))
    expect(tools[0]?.status).toBe("error")
    expect(tools[0]?.text).toContain("pre-deny-196 blocked")
    expect(await Bun.file(at("blocked-196.txt")).exists()).toBe(false)
  })

  test("PostToolUse hook marks a successful read", async () => {
    const { tools } = await h.run(call("read", { path: "README.md" }))
    expect(tools[0]?.status).toBe("completed")
    expect(tools[0]?.text).toContain("POST-MARKER-196")
    expect(await exists("POST_196")).toBe(true)
  })

  test("PostToolUseFailure hook marks a failing read (bug #268)", async () => {
    const { tools } = await h.run(call("read", { path: "does-not-exist-196.txt" }))
    expect(tools[0]?.status).toBe("error")
    // The bridge routes failures to PostToolUseFailure (hooks.ts); the marker
    // proves the handler ran for a real tool error. Observed: the handler's
    // additionalContext is NOT appended to the tool error text (bridge returns
    // early for failed tools) — routing proven, feedback path not.
    expect(await waitFor("FAIL_196")).toBe(true)
  })

  test("PermissionRequest hook marks and denies an .env read", async () => {
    const { tools } = await h.run(call("read", { path: ".env" }))
    expect(tools[0]?.status).toBe("error")
    expect(tools[0]?.text).toContain("perm-deny-196 blocked")
    expect(await exists("PERM_196")).toBe(true)
  })

  test("x-es.ShellPreExec rewrites a matching command", async () => {
    const { tools } = await h.run(call("shell", { command: "echo rewrite-shell-196" }))
    expect(tools[0]?.text).toContain("shell-rewritten-196")
    expect(await exists("SHELL_196")).toBe(true)
  })

  test("x-es.ShellPreExec deny substitutes exit 126 (bug #268)", async () => {
    const { tools } = await h.run(call("shell", { command: "echo deny-shell-196" }))
    // The bridge replaces the denied command with `printf … >&2; exit 126`
    // (hooks.ts): the block reason surfaces as the tool output.
    expect(tools[0]?.text).toContain("shell-deny-196 blocked")
    expect(tools[0]?.text).toContain("Exited with code 126")
  })

  test("Stop hook marker lands after the turn (emulated, ADVISORY for plain chat)", async () => {
    await h.run(call("read", { path: "README.md" }))
    expect(await waitFor("STOP_196")).toBe(true)
  })

  test("UserPromptSubmit context reaches the model", async () => {
    await h.run("an ordinary prompt 196")
    expect(allText(h.llm.requests.at(-1))).toContain("PROMPT-MARKER-196")
  })
})
