// Hook bridge: Claude Code hooks (from .opencode/hooks.json and
// .claude/settings*.json) running inside OpenCode v2.
//
//   PreToolUse          ← tool.execute.before (deny blocks; updatedInput rewrites;
//                          "ask" defers to the host permission prompt)
//   PostToolUse(Failure)← tool.execute.after (feedback/context appended, output replaced)
//   UserPromptSubmit    ← session prompt admission (block rejects, context appended)
//   SessionStart        ← first prompt of a session (startup) and after compaction
//   PermissionRequest   ← permission.evaluate when the host would ask
//   x-es.ShellPreExec   ← shell.create.before
//   Stop (emulated)     ← session.execution.succeeded: a block re-prompts the
//                          session (8-continuation cap). ADVISORY for plain chat:
//                          the host has already ended the turn when we re-prompt.
import {
  bwrapAvailable,
  fromOpenCode,
  HookEngine,
  permissionActionTool,
  shellQuote,
  toOpenCodeInput,
} from "@heretek-ai/es-core"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { Runtime } from "./runtime.ts"

const PERMISSION_CHECKED = new Set([
  "read",
  "write",
  "edit",
  "patch",
  "shell",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "skill",
  "subagent",
  "question",
])
const STOP_CAP = 8

type Ctx = {
  readonly generate: { text(input: any): Promise<{ text: string }> }
  readonly session: {
    prompt(input: any): Promise<unknown>
    context(input: any): Promise<readonly any[]>
    interrupt(input: any): Promise<unknown>
  }
}

export interface HookBridge {
  readonly engine: HookEngine
  before(event: { tool: string; agent: string; id: string; sessionID: string; input: unknown }): Promise<void>
  after(event: {
    tool: string
    agent: string
    id: string
    sessionID: string
    input: unknown
    status: string
    result?: any
    error?: any
  }): Promise<void>
  prompt(event: { sessionID: string; prompt: { text: string } }, agent?: string): Promise<void>
  context(event: { sessionID: string; agent: string; system: any[] }): Promise<void>
  evaluate(event: {
    sessionID: string
    agent?: string
    action: string
    resources: readonly string[]
    effect: string
    message?: string
    source?: { id: string }
  }): Promise<void>
  shell(event: { command: string; cwd: string }): Promise<void>
  onEvent(
    event: { type: string; data?: any },
    agentOf: (sessionID: string) => Promise<string | undefined>,
  ): Promise<void>
}

function lastAssistantText(context: readonly any[]): string {
  for (let i = context.length - 1; i >= 0; i--) {
    const message = context[i]
    if (message?.type !== "assistant") continue
    const text = (message.content ?? [])
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text ?? "")
      .join("")
    if (text) return text
  }
  return ""
}

export async function createHookBridge(
  ctx: Ctx,
  runtime: Runtime,
  mcpServers: () => readonly string[],
): Promise<HookBridge> {
  const engine = await HookEngine.create({
    root: runtime.root,
    stateDir: runtime.stateDir,
    generate: async (prompt, model) => {
      const slash = model?.indexOf("/") ?? -1
      const ref = model && slash > 0 ? { providerID: model.slice(0, slash), id: model.slice(slash + 1) } : undefined
      return (await ctx.generate.text({ prompt, ...(ref ? { model: ref } : {}) })).text
    },
  })
  const pendingContext = new Map<string, string[]>()
  const pendingAsk = new Map<string, string>()
  const sessionContext = new Map<string, string[]>()
  const startedSessions = new Set<string>()
  const continuations = new Map<string, number>()
  const base = (sessionId: string, agent?: string) => ({ sessionId, ...(agent ? { agent } : {}) })

  const stash = (map: Map<string, string[]>, key: string, texts: readonly string[]) => {
    if (texts.length) map.set(key, [...(map.get(key) ?? []), ...texts])
  }

  return {
    engine,

    async before(event) {
      await engine.refresh()
      if (!engine.has("PreToolUse")) return
      const tool = fromOpenCode(event.tool, event.input, runtime.root, mcpServers())
      const decision = await engine.preToolUse(base(event.sessionID, event.agent), tool, event.id)
      if (decision.stop) {
        await ctx.session.interrupt({ sessionID: event.sessionID }).catch(() => undefined)
        throw new ToolError({ message: `Stopped by a hook: ${decision.stop}` })
      }
      if (decision.decision === "deny") throw new ToolError({ message: decision.reason ?? "Denied by a hook" })
      if (decision.decision === "defer")
        throw new ToolError({ message: `Deferred by a hook${decision.reason ? `: ${decision.reason}` : ""}` })
      if (decision.decision === "ask") {
        const builtIn =
          PERMISSION_CHECKED.has(event.tool) ||
          mcpServers().some((server) => event.tool.startsWith(`${server.replace(/[^\w-]/g, "_")}_`))
        if (!builtIn)
          throw new ToolError({
            message: `A hook asked for approval, but ${event.tool} has no permission prompt to ask with; denied.`,
          })
        pendingAsk.set(event.id, decision.reason ?? "A hook asked to confirm this call")
      }
      if (decision.updatedInput)
        event.input = toOpenCodeInput(event.tool, decision.updatedInput, runtime.root, event.input)
      stash(pendingContext, event.id, [
        ...decision.additionalContext,
        ...decision.systemMessages.map((text) => `Hook message: ${text}`),
      ])
    },

    async after(event) {
      continuations.delete(event.sessionID)
      pendingAsk.delete(event.id)
      const earlier = pendingContext.get(event.id) ?? []
      pendingContext.delete(event.id)
      const failed = event.status !== "completed"
      const texts = [...earlier]
      let replacement: unknown
      if (engine.has(failed ? "PostToolUseFailure" : "PostToolUse")) {
        const tool = fromOpenCode(event.tool, event.input, runtime.root, mcpServers())
        const response = failed
          ? (event.error?.message ?? "tool failed")
          : (event.result?.output ?? event.result?.content)
        const post = await engine.postToolUse(base(event.sessionID, event.agent), tool, event.id, response, failed)
        texts.push(
          ...post.feedback,
          ...post.additionalContext,
          ...post.systemMessages.map((text) => `Hook message: ${text}`),
        )
        replacement = post.updatedToolOutput
        if (post.stop) await ctx.session.interrupt({ sessionID: event.sessionID }).catch(() => undefined)
      }
      if (failed || (!texts.length && replacement === undefined)) return
      const original =
        replacement === undefined
          ? event.result?.content
          : typeof replacement === "string"
            ? replacement
            : JSON.stringify(replacement)
      const block = texts.length ? `<hook-feedback>\n${texts.join("\n")}\n</hook-feedback>` : ""
      const content =
        typeof original === "string" || original === undefined
          ? [original ?? "", block].filter(Boolean).join("\n\n")
          : [...original, ...(block ? [{ type: "text", text: block }] : [])]
      event.result = { ...event.result, content }
    },

    async prompt(event, agent) {
      await engine.refresh()
      if (!startedSessions.has(event.sessionID)) {
        startedSessions.add(event.sessionID)
        if (engine.has("SessionStart"))
          stash(
            sessionContext,
            event.sessionID,
            (await engine.sessionStart(base(event.sessionID, agent), "startup")).additionalContext,
          )
      }
      if (!engine.has("UserPromptSubmit")) return
      const decision = await engine.userPromptSubmit(base(event.sessionID, agent), event.prompt.text)
      if (decision.block) throw new Error(`Prompt blocked by a hook: ${decision.block}`)
      const context = [...decision.additionalContext, ...decision.systemMessages.map((text) => `Hook message: ${text}`)]
      if (context.length)
        event.prompt.text = `${event.prompt.text}\n\n<system-reminder>\n${context.join("\n")}\n</system-reminder>`
    },

    context(event) {
      const texts = sessionContext.get(event.sessionID)
      if (texts?.length)
        event.system.push({ type: "text", text: `<session-start-hooks>\n${texts.join("\n")}\n</session-start-hooks>` })
      return Promise.resolve()
    },

    async evaluate(event) {
      const asked = event.source ? pendingAsk.get(event.source.id) : undefined
      if (event.effect === "deny") return
      if (asked) {
        event.effect = "ask"
        event.message = asked
      }
      if (event.effect !== "ask" || !engine.has("PermissionRequest")) return
      const tool = {
        name: permissionActionTool(event.action),
        aliases: [permissionActionTool(event.action), event.action],
        input: { resources: [...event.resources] },
      }
      const decision = await engine.permissionRequest(base(event.sessionID, event.agent), tool)
      if (decision.behavior === "deny") {
        event.effect = "deny"
        event.message = decision.message ?? "Denied by a hook"
      } else if (decision.behavior === "allow" && !asked) event.effect = "allow"
    },

    async shell(event) {
      if (!engine.has("x-es.ShellPreExec")) return
      const decision = await engine.shellPreExec(base(""), { command: event.command, cwd: event.cwd })
      if (decision.deny)
        event.command = `printf '%s\\n' ${shellQuote(`Blocked by a hook: ${decision.deny}`)} >&2; exit 126`
      else if (decision.command) event.command = decision.command
    },

    async onEvent(event, agentOf) {
      const sessionID = event.data?.sessionID
      if (!sessionID) return
      if (event.type === "session.compaction.ended" && engine.has("SessionStart")) {
        const agent = await agentOf(sessionID)
        stash(
          sessionContext,
          sessionID,
          (await engine.sessionStart(base(sessionID, agent), "compact")).additionalContext,
        )
        return
      }
      if (event.type !== "session.execution.succeeded" || !engine.has("Stop")) return
      const count = continuations.get(sessionID) ?? 0
      if (count >= STOP_CAP) {
        continuations.delete(sessionID)
        return
      }
      const agent = await agentOf(sessionID)
      const context = await ctx.session.context({ sessionID }).catch(() => [] as any[])
      const decision = await engine.stop(base(sessionID, agent), {
        stopHookActive: count > 0,
        lastAssistantMessage: lastAssistantText(context),
      })
      const feedback = [decision.block, ...decision.additionalContext].filter(Boolean)
      if (!feedback.length) {
        continuations.delete(sessionID)
        return
      }
      continuations.set(sessionID, count + 1)
      await ctx.session
        .prompt({
          sessionID,
          text: `<system-reminder>\nStop hook feedback (continuing):\n${feedback.join("\n")}\n</system-reminder>`,
        })
        .catch(() => undefined)
    },
  }
}

export { bwrapAvailable }
