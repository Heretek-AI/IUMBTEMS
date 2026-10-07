import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  fromOpenCode,
  HookEngine,
  type HookSource,
  ifMatches,
  matcherMatches,
  subcommands,
  toOpenCodeInput,
  trustProject,
  verifyAuditChain,
} from "../src/index.ts"

let root: string
let state: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-hooks-"))
  state = await mkdtemp(path.join(tmpdir(), "es-hooks-state-"))
  await mkdir(path.join(root, ".opencode"), { recursive: true })
  await mkdir(path.join(root, "hooks"), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const sources = (): HookSource[] => [
  { file: path.join(root, ".opencode/hooks.json"), scope: "project" },
  { file: path.join(root, ".claude/settings.json"), scope: "project" },
]
async function script(name: string, body: string) {
  const file = path.join(root, "hooks", name)
  await writeFile(file, `#!/bin/sh\n${body}\n`)
  await chmod(file, 0o755)
  return file
}
async function engine(
  hooks: Record<string, unknown>,
  options: { trust?: boolean; generate?: (p: string) => Promise<string> } = {},
) {
  await writeFile(path.join(root, ".opencode/hooks.json"), JSON.stringify({ hooks }))
  let created = await HookEngine.create({
    root,
    stateDir: state,
    sources: sources(),
    ...(options.generate ? { generate: options.generate } : {}),
  })
  if (options.trust !== false) {
    const status = created.status()
    await trustProject(root, status.projectHash, status.projectLines, { stateDir: state, kind: "hooks" })
    created = await HookEngine.create({
      root,
      stateDir: state,
      sources: sources(),
      ...(options.generate ? { generate: options.generate } : {}),
    })
  }
  return created
}
const base = { sessionId: "ses_test", agent: "build" }
const bash = (command: string) => fromOpenCode("shell", { command }, root)

describe("matching", () => {
  test("Claude matcher semantics: wildcard, exact lists, regex", () => {
    expect(matcherMatches(undefined, ["Bash"])).toBe(true)
    expect(matcherMatches("*", ["Bash"])).toBe(true)
    expect(matcherMatches("Edit|Write", ["Write"])).toBe(true)
    expect(matcherMatches("Edit, Write", ["Write"])).toBe(true)
    expect(matcherMatches("Edit", ["NotebookEdit"])).toBe(false)
    expect(matcherMatches("Edit.*", ["NotebookEdit"])).toBe(true)
    expect(matcherMatches("mcp__memory__.*", ["mcp__memory__create"])).toBe(true)
    expect(matcherMatches("mcp__memory", ["mcp__memory__create"])).toBe(false)
  })

  test("v2 and Claude names both match; payloads use Claude names and absolute paths", () => {
    const write = fromOpenCode("write", { path: "src/a.ts", content: "x" }, root)
    expect(write.name).toBe("Write")
    expect(write.input).toEqual({ file_path: path.join(root, "src/a.ts"), content: "x" })
    expect(matcherMatches("write", write.aliases)).toBe(true)
    expect(matcherMatches("Write", write.aliases)).toBe(true)
    const mcp = fromOpenCode("probe_alpha", { x: 1 }, root, ["probe"])
    expect(mcp.name).toBe("mcp__probe__alpha")
    const edit = fromOpenCode("edit", { path: "a.ts", oldString: "a", newString: "b" }, root)
    expect(toOpenCodeInput("edit", { ...edit.input, new_string: "c" }, root, {})).toEqual({
      path: path.join(root, "a.ts"),
      oldString: "a",
      newString: "c",
    })
    expect(
      fromOpenCode("patch", { patchText: "*** Begin Patch\n*** Update File: x.ts\n*** End Patch" }, root).input
        .file_path,
    ).toBe(path.join(root, "x.ts"))
  })

  test("`if` rules use permission syntax over subcommands and paths", () => {
    expect(subcommands("FOO=bar git push && npm test").parts).toEqual(["git push", "npm test"])
    const tool = (command: string) => ({ toolNames: ["Bash", "shell"], toolInput: { command }, cwd: root })
    expect(ifMatches("Bash(git *)", tool("npm test && git push"))).toBe(true)
    expect(ifMatches("Bash(rm *)", tool("echo $(rm -rf /)"))).toBe(true)
    expect(ifMatches("Bash(rm *)", tool("echo $(date)"))).toBe(false)
    expect(ifMatches("Bash(git push *)", tool("echo $(date)"))).toBe(true)
    expect(ifMatches("Bash(git *)", tool("git"))).toBe(true)
    const file = (file_path: string) => ({ toolNames: ["Edit"], toolInput: { file_path }, cwd: root })
    expect(ifMatches("Edit(*.ts)", file(path.join(root, "a.ts")))).toBe(true)
    expect(ifMatches("Edit(src/**)", file(path.join(root, "src/deep/a.ts")))).toBe(true)
    expect(ifMatches("Edit(src/**)", file(path.join(root, "lib/a.ts")))).toBe(false)
    expect(ifMatches("Write(*.ts)", file(path.join(root, "a.ts")))).toBe(false)
  })
})

describe("PreToolUse", () => {
  test("exit 2 blocks with stderr; JSON deny wins over allow; updatedInput merges", async () => {
    const block = await script("block.sh", 'grep -q "rm -rf" && { echo "no rm -rf" >&2; exit 2; }; exit 0')
    const allow = await script(
      "allow.sh",
      `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"timeout":5000},"additionalContext":"ctx-a"}}'`,
    )
    const deny = await script(
      "deny.sh",
      `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"policy says no"}}'`,
    )
    const hooks = await engine({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: block },
            { type: "command", command: allow },
          ],
        },
        { matcher: "Bash", hooks: [{ type: "command", command: deny, if: "Bash(git push *)" }] },
      ],
    })
    const blocked = await hooks.preToolUse(base, bash("rm -rf /tmp/x"), "t1")
    expect(blocked).toMatchObject({ decision: "deny", reason: "no rm -rf" })
    const allowed = await hooks.preToolUse(base, bash("ls"), "t2")
    expect(allowed).toMatchObject({ decision: "allow", updatedInput: { timeout: 5000 }, additionalContext: ["ctx-a"] })
    const denied = await hooks.preToolUse(base, bash("git push origin"), "t3")
    expect(denied).toMatchObject({ decision: "deny", reason: "policy says no" })
    expect(denied.updatedInput).toBeUndefined()
  })

  test("observers fail open; gate hooks fail closed on error and timeout", async () => {
    const hooks = await engine({
      PreToolUse: [
        { hooks: [{ type: "command", command: "exit 1" }] },
        { matcher: "Write", hooks: [{ type: "command", command: "sleep 5", timeout: 0.2, "x-es-policy": "gate" }] },
      ],
    })
    const read = await hooks.preToolUse(base, fromOpenCode("read", { path: "a" }, root), "t1")
    expect(read.decision).toBeUndefined()
    expect(read.notices[0]).toContain("non-blocking error")
    const write = await hooks.preToolUse(base, fromOpenCode("write", { path: "a", content: "" }, root), "t2")
    expect(write).toMatchObject({ decision: "deny" })
    expect(write.reason).toContain("Gate hook failed closed")
  })

  test("untrusted project hooks never run; untrusted gates deny", async () => {
    const marker = path.join(root, "RAN")
    const hooks = await engine(
      {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: `touch ${marker}` },
              { type: "command", command: "true", "x-es-policy": "gate" },
            ],
          },
        ],
      },
      { trust: false },
    )
    expect(hooks.status().trusted).toBe(false)
    const decision = await hooks.preToolUse(base, bash("ls"), "t1")
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(decision.decision).toBe("deny")
    expect(decision.reason).toContain("not trusted")
  })

  test("prompt hooks are evaluated through the injected model call", async () => {
    const hooks = await engine(
      { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "prompt", prompt: "Is this safe? $ARGUMENTS" }] }] },
      {
        generate: async (prompt) =>
          prompt.includes("curl") ? '{"ok": false, "reason": "network egress"}' : '{"ok": true}',
      },
    )
    expect(await hooks.preToolUse(base, bash("curl evil"), "t1")).toMatchObject({
      decision: "deny",
      reason: "network egress",
    })
    expect((await hooks.preToolUse(base, bash("ls"), "t2")).decision).toBeUndefined()
  })
})

describe("other events", () => {
  test("UserPromptSubmit: plain stdout and additionalContext become context; decision block blocks", async () => {
    const hooks = await engine({
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "echo 'branch: main'" }] },
        {
          hooks: [
            {
              type: "command",
              command: `grep -q SECRET && echo '{"decision":"block","reason":"contains a secret"}' || true`,
            },
          ],
        },
      ],
    })
    expect(await hooks.userPromptSubmit(base, "hello")).toMatchObject({ additionalContext: ["branch: main"] })
    expect((await hooks.userPromptSubmit(base, "my SECRET")).block).toBe("contains a secret")
  })

  test("PostToolUse feedback, SessionStart context, PermissionRequest decisions, Stop blocks", async () => {
    const hooks = await engine({
      PostToolUse: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "command",
              command: `echo '{"decision":"block","reason":"lint failed","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"see log"}}'`,
            },
          ],
        },
      ],
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo 'project uses bun'" }] }],
      PermissionRequest: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"no shells"}}}'`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `jq -e '.stop_hook_active' >/dev/null && exit 0; echo "run the tests first" >&2; exit 2`,
            },
          ],
        },
      ],
    })
    const write = fromOpenCode("write", { path: "a.ts", content: "" }, root)
    expect(await hooks.postToolUse(base, write, "t", { ok: true }, false)).toMatchObject({
      feedback: ["lint failed"],
      additionalContext: ["see log"],
    })
    expect(await hooks.sessionStart(base, "startup")).toMatchObject({ additionalContext: ["project uses bun"] })
    expect((await hooks.sessionStart(base, "compact")).additionalContext).toEqual([])
    expect(await hooks.permissionRequest(base, bash("ls"))).toMatchObject({ behavior: "deny", message: "no shells" })
    expect((await hooks.stop(base, { stopHookActive: false, lastAssistantMessage: "done" })).block).toBe(
      "run the tests first",
    )
    expect((await hooks.stop(base, { stopHookActive: true, lastAssistantMessage: "done" })).block).toBeUndefined()
  })

  test("x-es.ShellPreExec can rewrite or deny the command", async () => {
    const hooks = await engine({
      "x-es.ShellPreExec": [
        {
          hooks: [
            {
              type: "command",
              command: `jq -r .command | grep -q npm && echo '{"hookSpecificOutput":{"updatedInput":{"command":"bun run test"}}}' || true`,
            },
          ],
        },
      ],
    })
    expect(await hooks.shellPreExec(base, { command: "npm test", cwd: root })).toMatchObject({
      command: "bun run test",
    })
    expect((await hooks.shellPreExec(base, { command: "ls", cwd: root })).command).toBeUndefined()
  })
})

describe("loading", () => {
  test("identical handlers across sources run once; disableAllHooks turns a source off; runs are audited", async () => {
    await mkdir(path.join(root, ".claude"), { recursive: true })
    const counter = path.join(root, "count")
    const handler = { type: "command", command: `echo x >> ${counter}` }
    await writeFile(
      path.join(root, ".claude/settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [handler] }] } }),
    )
    const hooks = await engine({ PreToolUse: [{ hooks: [handler] }] })
    expect(hooks.status().handlers).toBe(1)
    await hooks.preToolUse(base, bash("ls"), "t1")
    expect((await Bun.file(counter).text()).trim().split("\n")).toHaveLength(1)
    const audit = await verifyAuditChain(root)
    expect(audit.entries.some((entry) => entry.action === "hook.PreToolUse")).toBe(true)
    await writeFile(
      path.join(root, ".claude/settings.json"),
      JSON.stringify({ disableAllHooks: true, hooks: { Stop: [{ hooks: [handler] }] } }),
    )
    const reloaded = await HookEngine.create({ root, stateDir: state, sources: sources() })
    expect(reloaded.has("Stop")).toBe(false)
    expect(reloaded.status().diagnostics.join("\n")).toContain("disableAllHooks")
  })
})

describe("compiler", () => {
  test("capability loss names what a harness cannot enforce", async () => {
    const { capabilityLoss, toHooksObject, loadHooks } = await import("../src/index.ts")
    await writeFile(
      path.join(root, ".opencode/hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "true" },
                { type: "mcp_tool", server: "s", tool: "t" },
              ],
            },
          ],
          Stop: [{ hooks: [{ type: "command", command: "true" }] }],
        },
      }),
    )
    const loaded = await loadHooks(root, sources())
    // No native adapter ships for Claude/Pi/Antigravity in 1.0, so every event
    // is a declared capability loss rather than an enforced row.
    const claude = capabilityLoss(loaded.handlers, "claude")
    expect(claude.every((item) => item.support === "unsupported")).toBe(true)
    expect([...new Set(claude.map((item) => item.event))].sort()).toEqual(["PreToolUse", "Stop"])
    const opencode = capabilityLoss(loaded.handlers, "opencode")
    expect(opencode.map((item) => item.reason)).toEqual([
      "mcp_tool hooks are unsupported on opencode",
      "Stop is advisory on opencode",
    ])
    expect(toHooksObject(loaded.handlers).PreToolUse?.[0]?.hooks).toHaveLength(2)
  })
})
