// Hook compiler: the canonical spec (Claude Code's hook schema) compiled per
// harness, with an explicit capability-loss report. Claude Code runs the spec
// natively; OpenCode runs it through the in-process bridge; Pi and
// Antigravity get adapters in 1.2/1.3 (their rows are declared here so the
// capability matrix is generated from one table).
import type { HooksObject, SourcedHandler } from "./spec.ts"

export type Harness = "claude" | "opencode" | "pi" | "antigravity"
export type Support = "enforced" | "advisory" | "unsupported"

export interface HookCapabilities {
  readonly events: Readonly<Record<string, Support>>
  readonly handlerTypes: Readonly<Record<string, Support>>
  readonly notes: readonly string[]
}

/** Every event the canonical spec can carry. */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "PermissionRequest",
  "Stop",
  "x-es.ShellPreExec",
] as const

/** Every handler type the canonical spec can carry. */
export const HOOK_HANDLER_TYPES = ["command", "http", "prompt", "mcp_tool", "agent"] as const

const allEvents = (support: Support): Readonly<Record<string, Support>> =>
  Object.fromEntries(HOOK_EVENTS.map((event) => [event, support]))
const allTypes = (support: Support): Readonly<Record<string, Support>> =>
  Object.fromEntries(HOOK_HANDLER_TYPES.map((type) => [type, support]))

// Only OpenCode is enforced in 1.0. The other harnesses have no shipping
// adapter yet, so every row is UNSUPPORTED until 1.1 (Claude), 1.2 (Pi) and
// 1.3 (Antigravity); claiming enforcement before then would be an unproven
// capability claim. The capability-matrix contract test enforces this.
export const HOOK_CAPABILITIES: Readonly<Record<Harness, HookCapabilities>> = {
  claude: {
    events: allEvents("unsupported"),
    handlerTypes: allTypes("unsupported"),
    notes: [
      "The canonical spec is Claude Code's own hook schema, but the installer adapter (marketplace plugin, hooks.json) ships in 1.1, so nothing is enforced in 1.0.",
    ],
  },
  opencode: {
    events: {
      PreToolUse: "enforced",
      PostToolUse: "enforced",
      PostToolUseFailure: "enforced",
      UserPromptSubmit: "enforced",
      SessionStart: "enforced",
      PermissionRequest: "enforced",
      Stop: "advisory",
      "x-es.ShellPreExec": "enforced",
    },
    handlerTypes: {
      command: "enforced",
      http: "enforced",
      prompt: "enforced",
      mcp_tool: "unsupported",
      agent: "unsupported",
    },
    notes: [
      "Bridged in-process via tool.execute.before/after, session prompt admission, permission.evaluate and shell.create.before.",
      "Stop is emulated: after the turn ends, a blocking Stop hook re-prompts the session (8-continuation cap).",
      'PreToolUse "ask" defers to the host permission prompt; tools without one are denied instead.',
      "PermissionRequest updatedInput/updatedPermissions are not applied (permission.evaluate can only allow, ask or deny).",
    ],
  },
  pi: {
    events: allEvents("unsupported"),
    handlerTypes: allTypes("unsupported"),
    notes: [
      "Planned for 1.2 through Pi's tool_call/tool_result/agent_before_settle events; the extension signature is confirmed (M0) but no adapter ships in 1.0.",
    ],
  },
  antigravity: {
    events: allEvents("unsupported"),
    handlerTypes: allTypes("unsupported"),
    notes: [
      "Planned for 1.3: Claude-schema commands wrapped by `es hooks adapt --from antigravity`; the hooks.json contract is confirmed (M0) but no adapter ships in 1.0.",
    ],
  },
}

export interface CapabilityLoss {
  readonly source: string
  readonly event: string
  readonly handler: string
  readonly support: Support
  readonly reason: string
}

/** What the given harness cannot enforce from this hook set. */
export function capabilityLoss(handlers: readonly SourcedHandler[], harness: Harness): CapabilityLoss[] {
  const caps = HOOK_CAPABILITIES[harness]
  const out: CapabilityLoss[] = []
  for (const item of handlers) {
    const event = caps.events[item.event] ?? "unsupported"
    const type = caps.handlerTypes[item.handler.type] ?? "unsupported"
    const handler = item.handler.type === "command" ? item.handler.command : item.handler.type
    if (event !== "enforced")
      out.push({
        source: item.source,
        event: item.event,
        handler,
        support: event,
        reason: `${item.event} is ${event} on ${harness}`,
      })
    else if (type !== "enforced")
      out.push({
        source: item.source,
        event: item.event,
        handler,
        support: type,
        reason: `${item.handler.type} hooks are ${type} on ${harness}`,
      })
  }
  return out
}

/** Re-assemble handlers into the canonical `hooks` object (what Claude Code consumes natively). */
export function toHooksObject(handlers: readonly SourcedHandler[]): HooksObject {
  const out: HooksObject = {}
  for (const item of handlers) {
    if (!out[item.event]) out[item.event] = []
    const groups = out[item.event]!
    let group = groups.find((existing) => existing.matcher === item.matcher)
    if (!group) {
      group = { ...(item.matcher !== undefined ? { matcher: item.matcher } : {}), hooks: [] }
      groups.push(group)
    }
    group.hooks.push(item.handler)
  }
  return out
}
