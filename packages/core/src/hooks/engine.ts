// The hook engine: Claude Code hook semantics, harness-neutral. Matching
// handlers run in parallel; outcomes aggregate per event (any deny wins for
// PreToolUse: deny > defer > ask > allow; contexts concatenate; input edits
// merge in order). Untrusted project hooks never run. Gate hooks
// ("x-es-policy": "gate") fail closed on error, timeout, missing support or
// missing trust; observers fail open, as Claude Code does. Every executed
// handler is written to the audit log.
import { appendAuditEntry } from "../audit/chain.ts"
import { isTrusted } from "../trust/store.ts"
import { type HookSource, hookSources, type LoadedHooks, loadHooks } from "./load.ts"
import { ifMatches, matcherMatches } from "./match.ts"
import { type HandlerOutcome, runHandler } from "./run.ts"
import type { SourcedHandler } from "./spec.ts"
import type { CanonicalTool } from "./tools.ts"

export interface HookEngineOptions {
  readonly root: string
  readonly stateDir?: string
  readonly sources?: HookSource[]
  readonly generate?: (prompt: string, model?: string) => Promise<string>
  readonly audit?: boolean
}

export interface BaseInput {
  readonly sessionId: string
  /** Agent ID of the session (Claude `agent_type`). */
  readonly agent?: string
  readonly transcriptPath?: string
}

interface Ran {
  readonly item: SourcedHandler
  readonly outcome: HandlerOutcome
}

export interface PreToolDecision {
  readonly decision?: "allow" | "deny" | "ask" | "defer"
  readonly reason?: string
  readonly updatedInput?: Record<string, unknown>
  readonly additionalContext: string[]
  readonly systemMessages: string[]
  readonly stop?: string
  readonly notices: string[]
}

export interface PostToolDecision {
  readonly feedback: string[]
  readonly additionalContext: string[]
  readonly updatedToolOutput?: unknown
  readonly systemMessages: string[]
  readonly stop?: string
  readonly notices: string[]
}

export interface PromptDecision {
  readonly block?: string
  readonly additionalContext: string[]
  readonly systemMessages: string[]
  readonly notices: string[]
}

export interface PermissionDecision {
  readonly behavior?: "allow" | "deny"
  readonly message?: string
  readonly notices: string[]
}

export interface StopDecision {
  readonly block?: string
  readonly additionalContext: string[]
  readonly notices: string[]
}

export interface ShellHookDecision {
  readonly deny?: string
  readonly command?: string
  readonly notices: string[]
}

const TOOL_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
])
const RANK = { deny: 4, defer: 3, ask: 2, allow: 1 } as const
const UNTRUSTED = "project hooks are not trusted yet"

const describe = (item: SourcedHandler) =>
  item.handler.type === "command"
    ? item.handler.command
    : item.handler.type === "http"
      ? item.handler.url
      : `${item.handler.type} hook`

export class HookEngine {
  private loaded: LoadedHooks = {
    handlers: [],
    projectHandlers: [],
    diagnostics: [],
    projectHash: "",
    projectLines: [],
  }
  private trusted = false
  private stamps = ""
  /** Recent non-blocking hook errors (shown by /hooks, never to the model). */
  readonly recent: string[] = []

  private constructor(private readonly options: HookEngineOptions) {}

  static async create(options: HookEngineOptions): Promise<HookEngine> {
    const engine = new HookEngine(options)
    await engine.reload()
    return engine
  }

  private async sourceStamps(): Promise<string> {
    const { stat } = await import("node:fs/promises")
    const sources = this.options.sources ?? hookSources(this.options.root)
    const stamps = await Promise.all(
      sources.map((source) =>
        stat(source.file).then(
          (info) => `${info.mtimeMs}:${info.size}`,
          () => "-",
        ),
      ),
    )
    return stamps.join("|")
  }

  /** Reload when any hook source file changed since the last load (cheap stat check). */
  async refresh(): Promise<void> {
    if ((await this.sourceStamps()) !== this.stamps) await this.reload()
    else if (!this.trusted)
      this.trusted = await isTrusted(this.options.root, this.loaded.projectHash, this.options.stateDir, "hooks")
  }

  async reload(): Promise<void> {
    this.stamps = await this.sourceStamps()
    this.loaded = await loadHooks(this.options.root, this.options.sources ?? hookSources(this.options.root))
    this.trusted =
      this.loaded.projectHandlers.length === 0 ||
      (await isTrusted(this.options.root, this.loaded.projectHash, this.options.stateDir, "hooks"))
  }

  status() {
    return {
      handlers: this.loaded.handlers.length,
      projectHandlers: this.loaded.projectHandlers.length,
      trusted: this.trusted,
      projectHash: this.loaded.projectHash,
      projectLines: this.loaded.projectLines,
      diagnostics: this.loaded.diagnostics,
    }
  }

  has(event: string): boolean {
    return this.loaded.handlers.some((item) => item.event === event)
  }

  private select(event: string, matchValues: readonly string[], tool?: CanonicalTool): SourcedHandler[] {
    return this.loaded.handlers.filter((item) => {
      if (item.event !== event) return false
      if (matchValues.length && !matcherMatches(item.matcher, matchValues)) return false
      if (item.handler.if !== undefined) {
        if (!TOOL_EVENTS.has(event) || !tool) return false
        return ifMatches(item.handler.if, { toolNames: tool.aliases, toolInput: tool.input, cwd: this.options.root })
      }
      return true
    })
  }

  private common(event: string, base: BaseInput) {
    return {
      session_id: base.sessionId,
      transcript_path: base.transcriptPath ?? "",
      cwd: this.options.root,
      permission_mode: "default",
      hook_event_name: event,
      ...(base.agent ? { agent_type: base.agent } : {}),
    }
  }

  private async execute(event: string, items: SourcedHandler[], input: Record<string, unknown>): Promise<Ran[]> {
    const ran = await Promise.all(
      items.map(async (item): Promise<Ran> => {
        const project = !item.source.startsWith("user:")
        if (project && !this.trusted)
          return {
            item,
            outcome: {
              status: "skipped",
              error: `${UNTRUSTED} (a human must run \`es trust\` or /es-trust)`,
              durationMs: 0,
            },
          }
        if (item.handler.type === "command" && item.handler.async) {
          void runHandler(item.handler, {
            root: this.options.root,
            event,
            input,
            ...(this.options.generate ? { generate: this.options.generate } : {}),
          })
          return { item, outcome: { status: "ok", durationMs: 0 } }
        }
        const outcome = await runHandler(item.handler, {
          root: this.options.root,
          event,
          input,
          ...(this.options.generate ? { generate: this.options.generate } : {}),
        })
        return { item, outcome }
      }),
    )
    if (this.options.audit !== false)
      for (const { item, outcome } of ran)
        await appendAuditEntry(this.options.root, {
          actor: `hook:${item.source}`,
          action: `hook.${event}`,
          payload: {
            matcher: item.matcher ?? "*",
            type: item.handler.type,
            target: describe(item).slice(0, 200),
            status: outcome.status,
            exitCode: outcome.exitCode ?? null,
            durationMs: outcome.durationMs,
            ...(outcome.error ? { error: outcome.error.slice(0, 300) } : {}),
          },
        }).catch(() => undefined)
    return ran
  }

  /** Failure handling: gates fail closed (returns a block reason), observers fail open (notice). */
  private failure(item: SourcedHandler, outcome: HandlerOutcome, notices: string[]): string | undefined {
    if (outcome.status !== "error" && outcome.status !== "timeout" && outcome.status !== "skipped") return undefined
    const text = `${describe(item)} [${item.source}]: ${outcome.error ?? outcome.status}`
    if (item.handler["x-es-policy"] === "gate") return `Gate hook failed closed — ${text}`
    // Untrusted observers are skipped silently (the trust state is visible in /hooks and status).
    if (outcome.error?.startsWith(UNTRUSTED)) return undefined
    notices.push(`hook ${item.event} non-blocking error — ${text}`)
    this.recent.push(`${new Date().toISOString()} ${item.event}: ${text}`)
    if (this.recent.length > 50) this.recent.shift()
    return undefined
  }

  async preToolUse(base: BaseInput, tool: CanonicalTool, toolUseId: string): Promise<PreToolDecision> {
    const items = this.select("PreToolUse", tool.aliases, tool)
    const notices: string[] = []
    const additionalContext: string[] = []
    const systemMessages: string[] = []
    if (!items.length) return { additionalContext, systemMessages, notices }
    const ran = await this.execute("PreToolUse", items, {
      ...this.common("PreToolUse", base),
      tool_name: tool.name,
      tool_input: tool.input,
      tool_use_id: toolUseId,
    })
    let decision: PreToolDecision["decision"]
    let reason: string | undefined
    let updatedInput: Record<string, unknown> | undefined
    let stop: string | undefined
    const consider = (next: NonNullable<PreToolDecision["decision"]>, why?: string) => {
      if (!decision || RANK[next] > RANK[decision]) {
        decision = next
        reason = why
      } else if (next === decision && why && next === "deny") reason = reason ? `${reason}; ${why}` : why
    }
    for (const { item, outcome } of ran) {
      const failed = this.failure(item, outcome, notices)
      if (failed) {
        consider("deny", failed)
        continue
      }
      const json = outcome.json ?? {}
      const out = json.hookSpecificOutput ?? {}
      if (json.continue === false) stop = json.stopReason ?? "Stopped by a hook"
      if (typeof json.systemMessage === "string") systemMessages.push(json.systemMessage)
      if (json.promptVerdict) {
        if (json.promptVerdict.ok === false) consider("deny", json.promptVerdict.reason ?? "Denied by a prompt hook")
        continue
      }
      if (outcome.status === "blocked") {
        consider("deny", out.permissionDecisionReason ?? json.reason ?? (outcome.stderr || "Blocked by a hook"))
        continue
      }
      const legacy = json.decision === "approve" ? "allow" : json.decision === "block" ? "deny" : undefined
      const verdict = out.permissionDecision ?? legacy
      if (verdict === "allow" || verdict === "deny" || verdict === "ask" || verdict === "defer")
        consider(verdict, out.permissionDecisionReason ?? json.reason)
      if (out.updatedInput && typeof out.updatedInput === "object" && verdict !== "defer" && verdict !== "deny")
        updatedInput = { ...(updatedInput ?? {}), ...out.updatedInput }
      if (typeof out.additionalContext === "string") additionalContext.push(out.additionalContext)
    }
    return {
      ...(decision ? { decision } : {}),
      ...(reason ? { reason } : {}),
      ...(updatedInput && decision !== "deny" ? { updatedInput } : {}),
      ...(stop ? { stop } : {}),
      additionalContext,
      systemMessages,
      notices,
    }
  }

  async postToolUse(
    base: BaseInput,
    tool: CanonicalTool,
    toolUseId: string,
    response: unknown,
    failed: boolean,
  ): Promise<PostToolDecision> {
    const event = failed ? "PostToolUseFailure" : "PostToolUse"
    const items = this.select(event, tool.aliases, tool)
    const result: {
      feedback: string[]
      additionalContext: string[]
      systemMessages: string[]
      notices: string[]
      updatedToolOutput?: unknown
      stop?: string
    } = {
      feedback: [],
      additionalContext: [],
      systemMessages: [],
      notices: [],
    }
    if (!items.length) return result
    const ran = await this.execute(event, items, {
      ...this.common(event, base),
      tool_name: tool.name,
      tool_input: tool.input,
      tool_use_id: toolUseId,
      ...(failed ? { error: String(response) } : { tool_response: response }),
    })
    for (const { item, outcome } of ran) {
      const closed = this.failure(item, outcome, result.notices)
      if (closed) result.feedback.push(closed)
      const json = outcome.json ?? {}
      const out = json.hookSpecificOutput ?? {}
      if (json.continue === false) result.stop = json.stopReason ?? "Stopped by a hook"
      if (typeof json.systemMessage === "string") result.systemMessages.push(json.systemMessage)
      if (json.promptVerdict?.ok === false)
        result.feedback.push(json.promptVerdict.reason ?? "Flagged by a prompt hook")
      if (outcome.status === "blocked" && outcome.stderr) result.feedback.push(outcome.stderr)
      if (json.decision === "block" && json.reason) result.feedback.push(json.reason)
      if (typeof out.additionalContext === "string") result.additionalContext.push(out.additionalContext)
      if (out.updatedToolOutput !== undefined) result.updatedToolOutput = out.updatedToolOutput
      else if (out.updatedMCPToolOutput !== undefined) result.updatedToolOutput = out.updatedMCPToolOutput
    }
    return result
  }

  async userPromptSubmit(base: BaseInput, prompt: string): Promise<PromptDecision> {
    const items = this.select("UserPromptSubmit", [])
    const result: { block?: string; additionalContext: string[]; systemMessages: string[]; notices: string[] } = {
      additionalContext: [],
      systemMessages: [],
      notices: [],
    }
    if (!items.length) return result
    const ran = await this.execute("UserPromptSubmit", items, { ...this.common("UserPromptSubmit", base), prompt })
    const blocks: string[] = []
    for (const { item, outcome } of ran) {
      const closed = this.failure(item, outcome, result.notices)
      if (closed) blocks.push(closed)
      const json = outcome.json ?? {}
      const out = json.hookSpecificOutput ?? {}
      if (typeof json.systemMessage === "string") result.systemMessages.push(json.systemMessage)
      if (json.promptVerdict?.ok === false) blocks.push(json.promptVerdict.reason ?? "Blocked by a prompt hook")
      if (outcome.status === "blocked") blocks.push(json.reason ?? (outcome.stderr || "Blocked by a hook"))
      else if (json.decision === "block") blocks.push(json.reason ?? "Blocked by a hook")
      if (typeof out.additionalContext === "string") result.additionalContext.push(out.additionalContext)
      if (outcome.status === "ok" && outcome.text) result.additionalContext.push(outcome.text)
    }
    if (blocks.length) result.block = blocks.join("; ")
    return result
  }

  async sessionStart(
    base: BaseInput,
    source: "startup" | "resume" | "clear" | "compact" | "fork",
  ): Promise<{ additionalContext: string[]; notices: string[] }> {
    const items = this.select("SessionStart", [source])
    const result = { additionalContext: [] as string[], notices: [] as string[] }
    if (!items.length) return result
    const ran = await this.execute("SessionStart", items, { ...this.common("SessionStart", base), source })
    for (const { item, outcome } of ran) {
      this.failure(item, outcome, result.notices)
      const out = outcome.json?.hookSpecificOutput ?? {}
      if (typeof out.additionalContext === "string") result.additionalContext.push(out.additionalContext)
      if (outcome.status === "ok" && outcome.text) result.additionalContext.push(outcome.text)
    }
    return result
  }

  async permissionRequest(base: BaseInput, tool: CanonicalTool): Promise<PermissionDecision> {
    const items = this.select("PermissionRequest", tool.aliases, tool)
    const notices: string[] = []
    if (!items.length) return { notices }
    const ran = await this.execute("PermissionRequest", items, {
      ...this.common("PermissionRequest", base),
      tool_name: tool.name,
      tool_input: tool.input,
    })
    let behavior: PermissionDecision["behavior"]
    let message: string | undefined
    for (const { item, outcome } of ran) {
      const closed = this.failure(item, outcome, notices)
      if (closed) {
        behavior = "deny"
        message = closed
        continue
      }
      const decision = outcome.json?.hookSpecificOutput?.decision
      if (decision?.behavior === "deny") {
        behavior = "deny"
        message = decision.message ?? message ?? "Denied by a hook"
      } else if (decision?.behavior === "allow" && behavior !== "deny") behavior = "allow"
    }
    return { ...(behavior ? { behavior } : {}), ...(message ? { message } : {}), notices }
  }

  async stop(base: BaseInput, input: { stopHookActive: boolean; lastAssistantMessage: string }): Promise<StopDecision> {
    const items = this.select("Stop", [])
    const result: { block?: string; additionalContext: string[]; notices: string[] } = {
      additionalContext: [],
      notices: [],
    }
    if (!items.length) return result
    const ran = await this.execute("Stop", items, {
      ...this.common("Stop", base),
      stop_hook_active: input.stopHookActive,
      last_assistant_message: input.lastAssistantMessage,
      background_tasks: [],
      session_crons: [],
    })
    const blocks: string[] = []
    for (const { item, outcome } of ran) {
      const closed = this.failure(item, outcome, result.notices)
      if (closed) blocks.push(closed)
      const json = outcome.json ?? {}
      const verdict = json.promptVerdict
      if (verdict?.ok === false && !verdict.impossible)
        blocks.push(verdict.reason ?? "Continue: a prompt hook says the work is not done")
      if (outcome.status === "blocked") blocks.push(json.reason ?? (outcome.stderr || "A Stop hook asked to continue"))
      else if (json.decision === "block") blocks.push(json.reason ?? "A Stop hook asked to continue")
      const context = json.hookSpecificOutput?.additionalContext
      if (typeof context === "string") result.additionalContext.push(context)
    }
    if (blocks.length) result.block = blocks.join("\n")
    return result
  }

  /** Namespaced extra event: before a shell process is created (OpenCode `shell.create.before`). */
  async shellPreExec(base: BaseInput, input: { command: string; cwd: string }): Promise<ShellHookDecision> {
    const items = this.select("x-es.ShellPreExec", [])
    const notices: string[] = []
    if (!items.length) return { notices }
    const ran = await this.execute("x-es.ShellPreExec", items, {
      ...this.common("x-es.ShellPreExec", base),
      command: input.command,
      shell_cwd: input.cwd,
    })
    let deny: string | undefined
    let command: string | undefined
    for (const { item, outcome } of ran) {
      const closed = this.failure(item, outcome, notices)
      if (closed) deny = closed
      const out = outcome.json?.hookSpecificOutput ?? {}
      if (outcome.status === "blocked") deny = outcome.stderr || "Blocked by a hook"
      else if (out.permissionDecision === "deny") deny = out.permissionDecisionReason ?? "Blocked by a hook"
      if (typeof out.updatedInput?.command === "string") command = out.updatedInput.command
    }
    return { ...(deny ? { deny } : {}), ...(command && !deny ? { command } : {}), notices }
  }
}
