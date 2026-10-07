// Real-host tests of the hook bridge: Claude Code hooks from
// .claude/settings.json and .opencode/hooks.json run inside OpenCode v2.
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
import { allText, boot, directiveScript, type Harness, lastAgentRequest, systemText } from "@heretek-ai/es-testkit"
import { EsRpc } from "../src/rpc-def.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const json = (value: unknown) => `echo '${JSON.stringify(value)}'`

const hooks = {
  PreToolUse: [
    {
      matcher: "Write",
      hooks: [
        {
          type: "command",
          command: `grep -q forbidden.txt && { echo "writing forbidden.txt is not allowed" >&2; exit 2; }; touch "$CLAUDE_PROJECT_DIR/PRE_RAN"; exit 0`,
        },
      ],
    },
    {
      matcher: "shell",
      hooks: [
        {
          type: "command",
          if: "Bash(echo original*)",
          command: json({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: { command: "echo rewritten-by-hook" },
            },
          }),
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
          command: json({
            hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "POST-HOOK-CONTEXT" },
          }),
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: "command",
          command: `grep -q FORBIDDEN && { echo '{"decision":"block","reason":"no forbidden prompts"}'; exit 0; }; echo PROMPT-HOOK-CONTEXT`,
        },
      ],
    },
  ],
  SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo SESSION-START-CONTEXT" }] }],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: `input=$(cat); echo "$input" | jq -e .stop_hook_active >/dev/null && exit 0; echo "$input" | jq -r .last_assistant_message | grep -q "please continue" || exit 0; echo "run the checks before stopping" >&2; exit 2`,
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
          command: json({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "deny", message: "env files stay closed" },
            },
          }),
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
            command: `jq -r .command | grep -q "npm test" && ${json({ hookSpecificOutput: { updatedInput: { command: "echo shell-rewritten" } } })} || true`,
          },
        ],
      },
    ],
    PreToolUse: [
      { matcher: "Glob", hooks: [{ type: "command", command: "sleep 5", timeout: 0.3, "x-es-policy": "gate" }] },
    ],
  },
}

let state: string
let h: Harness
let signer: HumanSigner
const where = () => ({ location: h.location })

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-hookbridge-state-"))
  await sealHumanKey("test-passphrase-1234", state)
  signer = await unlockHumanKey("test-passphrase-1234", state)
  h = await boot({
    git: true,
    script: (request, index) => {
      // Stop-hook scenario: the model claims to be done until it sees the hook feedback.
      const text = allText(request)
      if (text.includes("STOP-SCENARIO") && !text.includes("Stop hook feedback"))
        return { text: "done, please continue later" }
      if (text.includes("Stop hook feedback")) return { text: "ran the checks" }
      return directiveScript(request, index)
    },
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: {
      "README.md": "# hooks\n",
      ".env": "SECRET=1\n",
      ".claude/settings.json": JSON.stringify({ hooks }),
      ".opencode/hooks.json": JSON.stringify(extraHooks),
    },
  })
}, 60_000)
afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("hook bridge on the real host", () => {
  test("untrusted project hooks do not run; trusting them through the human dialog enables them", async () => {
    const before = await h.run(call("write", { path: "a.txt", content: "a" }))
    expect(before.tools[0]?.status).toBe("completed")
    expect(await Bun.file(path.join(h.directory, "PRE_RAN")).exists()).toBe(false)
    const rpc = (h.opencode as any).rpc(EsRpc)
    const preview = await rpc.previewTrust({}, where())
    expect(preview.lines.join("\n")).toContain("hook PreToolUse(Write)")
    expect(typeof rpc.trust).not.toBe("function")
    const { config } = await loadGatesConfig(h.directory)
    const gates = await commandSetHash(h.directory, config.commands)
    const hooks = (await HookEngine.create({ root: h.directory, stateDir: state, audit: false })).status()
    await trustProject(h.directory, gates.hash, gates.lines, { stateDir: state, signer })
    if (hooks.projectHash)
      await trustProject(h.directory, hooks.projectHash, hooks.projectLines, {
        stateDir: state,
        kind: "hooks",
        signer,
      })
    const after = await h.run(call("write", { path: "b.txt", content: "b" }))
    expect(after.tools[0]?.status).toBe("completed")
    expect(await Bun.file(path.join(h.directory, "PRE_RAN")).exists()).toBe(true)
  })

  test("PreToolUse: exit 2 blocks a v2 write matched by its Claude name", async () => {
    const { tools } = await h.run(call("write", { path: "forbidden.txt", content: "x" }))
    expect(tools[0]?.status).toBe("error")
    expect(tools[0]?.text).toContain("writing forbidden.txt is not allowed")
    expect(await Bun.file(path.join(h.directory, "forbidden.txt")).exists()).toBe(false)
  })

  test("PreToolUse: a v2-name matcher plus `if` rewrites the shell command via updatedInput", async () => {
    const { tools } = await h.run(call("shell", { command: "echo original" }))
    expect(tools[0]?.text).toContain("rewritten-by-hook")
  })

  test("PostToolUse context is appended to the tool result", async () => {
    const { tools } = await h.run(call("read", { path: "README.md" }))
    expect(tools[0]?.text).toContain("POST-HOOK-CONTEXT")
  })

  test("UserPromptSubmit adds context, and a block rejects the prompt", async () => {
    await h.run("an ordinary prompt")
    expect(allText(lastAgentRequest(h.llm.requests))).toContain("PROMPT-HOOK-CONTEXT")
    const before = h.llm.requests.length
    await expect(h.run("something FORBIDDEN")).rejects.toBeDefined()
    expect(h.llm.requests.length).toBe(before)
  })

  test("SessionStart context reaches the session's system prompt", async () => {
    await h.run("first prompt of a new session")
    expect(systemText(lastAgentRequest(h.llm.requests))).toContain("SESSION-START-CONTEXT")
  })

  test("Stop is emulated: a blocking Stop hook re-prompts the session once", async () => {
    const run = await h.run("STOP-SCENARIO")
    for (let i = 0; i < 50 && !allText(lastAgentRequest(h.llm.requests)).includes("Stop hook feedback"); i++)
      await Bun.sleep(100)
    await h.opencode.sessions.wait({ sessionID: run.sessionID } as any)
    expect(allText(lastAgentRequest(h.llm.requests))).toContain("run the checks before stopping")
  }, 30_000)

  test("x-es.ShellPreExec rewrites the command before the shell starts", async () => {
    const { tools } = await h.run(call("shell", { command: "npm test" }))
    expect(tools[0]?.text).toContain("shell-rewritten")
  })

  test("PermissionRequest denies what the host would ask about", async () => {
    const { tools } = await h.run(call("read", { path: ".env" }))
    expect(tools[0]?.status).toBe("error")
    expect(tools[0]?.text).toContain("env files stay closed")
  })

  test("a gate hook that times out fails closed", async () => {
    const { tools } = await h.run(call("glob", { pattern: "*.md" }))
    expect(tools[0]?.status).toBe("error")
    expect(tools[0]?.text).toContain("Gate hook failed closed")
  })
})
