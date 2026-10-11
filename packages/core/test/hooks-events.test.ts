// Issue #196 §2 — engine-level proof for every bridged hook event.
//
// Each event gets a hook that writes a marker file; the test drives the
// matching engine method and asserts the marker landed. This complements
// packages/opencode/test/hooks-events.test.ts, which drives the same events
// through the real in-process OpenCode v2 host.
//
// NOTE (bug #265): hook commands run UNSANDBOXED with the full parent env
// (run.ts uses inheritEnv:true and no sandbox knob). The "parent env is
// visible" test below pins that observable behaviour without changing it —
// Claude Code parity by design, not a sandbox.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { fromOpenCode, HookEngine, type HookSource, trustProject } from "../src/index.ts"

let root: string
let state: string
const PASSPHRASE = "test-passphrase-196-events"
let signer: HumanSigner
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-hooks-events-"))
  state = await mkdtemp(path.join(tmpdir(), "es-hooks-events-state-"))
  await sealHumanKey(PASSPHRASE, state)
  signer = await unlockHumanKey(PASSPHRASE, state)
  await mkdir(path.join(root, ".opencode"), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const sources = (): HookSource[] => [{ file: path.join(root, ".opencode/hooks.json"), scope: "project" }]
async function engine(hooks: Record<string, unknown>) {
  await writeFile(path.join(root, ".opencode/hooks.json"), JSON.stringify({ hooks }))
  let created = await HookEngine.create({ root, stateDir: state, sources: sources(), audit: false })
  const status = created.status()
  await trustProject(root, status.projectHash, status.projectLines, { stateDir: state, kind: "hooks", signer })
  created = await HookEngine.create({ root, stateDir: state, sources: sources(), audit: false })
  return created
}
const base = { sessionId: "ses_196", agent: "build" }
const marker = (name: string) => path.join(root, name)
const touch = (name: string, extra = "") => `touch ${marker(name)}${extra ? `; ${extra}` : ""}`

describe("hook events write marker files (issue #196 §2)", () => {
  test("PreToolUse marker lands; exit 2 deny blocks the tool", async () => {
    const hooks = await engine({
      PreToolUse: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "command",
              command: `${touch("PRE_196")}; input=$(cat); echo "$input" | grep -q "deny-pre-196" && { echo "pre-deny-196 blocked" >&2; exit 2; }; exit 0`,
            },
          ],
        },
      ],
    })
    const ok = await hooks.preToolUse(base, fromOpenCode("write", { path: "a.txt", content: "fine" }, root), "t1")
    expect(ok.decision).toBeUndefined()
    expect(await Bun.file(marker("PRE_196")).exists()).toBe(true)
    const denied = await hooks.preToolUse(
      base,
      fromOpenCode("write", { path: "b.txt", content: "deny-pre-196" }, root),
      "t2",
    )
    expect(denied).toMatchObject({ decision: "deny", reason: "pre-deny-196 blocked" })
  })

  test("PostToolUse marker lands with additionalContext", async () => {
    const hooks = await engine({
      PostToolUse: [
        {
          matcher: "Read",
          hooks: [
            {
              type: "command",
              command: `${touch("POST_196")}; echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"POST-MARKER-196"}}'`,
            },
          ],
        },
      ],
    })
    const out = await hooks.postToolUse(base, fromOpenCode("read", { path: "a.txt" }, root), "t1", { ok: true }, false)
    expect(await Bun.file(marker("POST_196")).exists()).toBe(true)
    expect(out.additionalContext).toContain("POST-MARKER-196")
  })

  test("PostToolUseFailure marker lands when driven with failed=true (bug #268)", async () => {
    const hooks = await engine({
      PostToolUseFailure: [
        {
          matcher: "Read",
          hooks: [
            {
              type: "command",
              command: `${touch("FAIL_196")}; echo '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"FAILURE-MARKER-196"}}'`,
            },
          ],
        },
      ],
    })
    // failed=false must NOT run the PostToolUseFailure handler.
    const ok = await hooks.postToolUse(base, fromOpenCode("read", { path: "a.txt" }, root), "t1", "content", false)
    expect(ok.additionalContext).toEqual([])
    expect(await Bun.file(marker("FAIL_196")).exists()).toBe(false)
    // failed=true routes to the PostToolUseFailure event (engine.ts).
    const failed = await hooks.postToolUse(
      base,
      fromOpenCode("read", { path: "missing.txt" }, root),
      "t2",
      "Error: file not found",
      true,
    )
    expect(await Bun.file(marker("FAIL_196")).exists()).toBe(true)
    expect(failed.additionalContext).toContain("FAILURE-MARKER-196")
  })

  test("UserPromptSubmit marker lands; block blocks", async () => {
    const hooks = await engine({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `${touch("PROMPT_196")}; grep -q "block-prompt-196" && echo '{"decision":"block","reason":"prompt blocked 196"}' || echo "PROMPT-MARKER-196"`,
            },
          ],
        },
      ],
    })
    const out = await hooks.userPromptSubmit(base, "hello")
    expect(await Bun.file(marker("PROMPT_196")).exists()).toBe(true)
    expect(out.additionalContext).toContain("PROMPT-MARKER-196")
    expect((await hooks.userPromptSubmit(base, "please block-prompt-196")).block).toContain("prompt blocked 196")
  })

  test("SessionStart marker lands for startup only", async () => {
    const hooks = await engine({
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: touch("START_196") + "; echo START-MARKER-196" }] },
      ],
    })
    const out = await hooks.sessionStart(base, "startup")
    expect(await Bun.file(marker("START_196")).exists()).toBe(true)
    expect(out.additionalContext).toContain("START-MARKER-196")
    await rm(marker("START_196"), { force: true })
    expect((await hooks.sessionStart(base, "compact")).additionalContext).toEqual([])
    expect(await Bun.file(marker("START_196")).exists()).toBe(false)
  })

  test("PermissionRequest marker lands; deny JSON denies", async () => {
    const hooks = await engine({
      PermissionRequest: [
        {
          matcher: "Read",
          hooks: [
            {
              type: "command",
              command: `${touch("PERM_196")}; echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"perm-deny-196"}}}'`,
            },
          ],
        },
      ],
    })
    const out = await hooks.permissionRequest(base, fromOpenCode("read", { path: ".env" }, root))
    expect(await Bun.file(marker("PERM_196")).exists()).toBe(true)
    expect(out).toMatchObject({ behavior: "deny", message: "perm-deny-196" })
  })

  test("Stop marker lands; exit 2 blocks (emulated after the turn, ADVISORY for plain chat)", async () => {
    const hooks = await engine({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              // The engine passes stop_hook_active in the input; the hook itself
              // suppresses the block on a continuation, as Claude Code does.
              command: `${touch("STOP_196")}; input=$(cat); echo "$input" | grep -q '"stop_hook_active":true' && exit 0; echo "stop-continue-196" >&2; exit 2`,
            },
          ],
        },
      ],
    })
    const out = await hooks.stop(base, { stopHookActive: false, lastAssistantMessage: "done" })
    expect(await Bun.file(marker("STOP_196")).exists()).toBe(true)
    expect(out.block).toContain("stop-continue-196")
    // stop_hook_active suppresses the block, as Claude Code does.
    expect((await hooks.stop(base, { stopHookActive: true, lastAssistantMessage: "done" })).block).toBeUndefined()
  })
})

describe("x-es.ShellPreExec rewrite AND deny (bug #268)", () => {
  test("rewrite branch returns the replacement command", async () => {
    const hooks = await engine({
      "x-es.ShellPreExec": [
        {
          hooks: [
            {
              type: "command",
              command: `input=$(cat); echo "$input" | grep -q "rewrite-shell-196" && echo '{"hookSpecificOutput":{"updatedInput":{"command":"echo shell-rewritten-196"}}}' || true`,
            },
          ],
        },
      ],
    })
    expect(await hooks.shellPreExec(base, { command: "echo rewrite-shell-196", cwd: root })).toMatchObject({
      command: "echo shell-rewritten-196",
    })
    expect((await hooks.shellPreExec(base, { command: "echo plain", cwd: root })).command).toBeUndefined()
  })

  test("deny branch: exit 2 denies; deny wins over a simultaneous rewrite (command && !deny precedence)", async () => {
    const hooks = await engine({
      "x-es.ShellPreExec": [
        {
          hooks: [
            {
              type: "command",
              command: `input=$(cat); echo "$input" | grep -q "deny-shell-196" && { echo "shell-deny-196 blocked" >&2; exit 2; }; echo "$input" | grep -q "both-shell-196" && echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"both denied 196","updatedInput":{"command":"echo should-not-run-196"}}}' || true`,
            },
          ],
        },
      ],
    })
    // Exit-2 deny carries the stderr reason.
    const denied = await hooks.shellPreExec(base, { command: "echo deny-shell-196", cwd: root })
    expect(denied.deny).toContain("shell-deny-196 blocked")
    expect(denied.command).toBeUndefined()
    // JSON deny with a simultaneous updatedInput.command: deny wins, command is suppressed.
    const both = await hooks.shellPreExec(base, { command: "echo both-shell-196", cwd: root })
    expect(both.deny).toContain("both denied 196")
    expect(both.command).toBeUndefined()
  })
})

describe("hooks run unsandboxed with parent env (bug #265, observable behaviour)", () => {
  test("parent process env is visible inside a hook command", async () => {
    const key = "ES_HOOK_PARENT_PROBE_196"
    const value = `probe-196-${Date.now()}`
    process.env[key] = value
    try {
      const hooks = await engine({
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: `echo "$${key}" > ${marker("ENV_196")}` }],
          },
        ],
      })
      await hooks.preToolUse(base, fromOpenCode("shell", { command: "echo hi" }, root), "t1")
      expect((await Bun.file(marker("ENV_196")).text()).trim()).toBe(value)
    } finally {
      delete process.env[key]
    }
  })
})
