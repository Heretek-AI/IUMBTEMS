// Canonical hook spec: Claude Code's hooks JSON schema, exactly, plus
// namespaced extras ("x-es-*" keys, "x-es." event names). Unknown keys are
// preserved and ignored, as Claude Code does, so one file serves every harness.
import { z } from "zod"

/** Events the OpenCode bridge runs (Claude names), plus our namespaced shell pre-exec event. */
export const BRIDGED_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "PermissionRequest",
  "Stop",
  "x-es.ShellPreExec",
] as const
export type BridgedEvent = (typeof BRIDGED_EVENTS)[number]

/** Gate hooks fail closed (errors and timeouts block); observers fail open (Claude semantics). */
export const HookPolicySchema = z.enum(["gate", "observer"])
export type HookPolicy = z.infer<typeof HookPolicySchema>

const common = {
  if: z.string().optional(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
  "x-es-policy": HookPolicySchema.optional(),
}

export const CommandHookSchema = z.looseObject({
  type: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(),
  shell: z.enum(["bash", "powershell"]).optional(),
  ...common,
})

export const HttpHookSchema = z.looseObject({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: z.array(z.string()).optional(),
  ...common,
})

export const McpToolHookSchema = z.looseObject({
  type: z.literal("mcp_tool"),
  server: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  ...common,
})

export const PromptHookSchema = z.looseObject({
  type: z.literal("prompt"),
  prompt: z.string().min(1),
  model: z.string().optional(),
  continueOnBlock: z.boolean().optional(),
  ...common,
})

export const AgentHookSchema = z.looseObject({
  type: z.literal("agent"),
  prompt: z.string().min(1),
  model: z.string().optional(),
  ...common,
})

export const HookHandlerSchema = z.discriminatedUnion("type", [
  CommandHookSchema,
  HttpHookSchema,
  McpToolHookSchema,
  PromptHookSchema,
  AgentHookSchema,
])
export type HookHandler = z.infer<typeof HookHandlerSchema>

export const MatcherGroupSchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(HookHandlerSchema),
})
export type MatcherGroup = z.infer<typeof MatcherGroupSchema>

/** The `hooks` object of a settings file: event name → matcher groups. */
export const HooksObjectSchema = z.record(z.string(), z.array(MatcherGroupSchema))
export type HooksObject = z.infer<typeof HooksObjectSchema>

/** A resolved handler with where it came from (for trust, audit and dedupe). */
export interface SourcedHandler {
  readonly event: string
  readonly matcher: string | undefined
  readonly handler: HookHandler
  /** Source file, relative to the project root when inside it. */
  readonly source: string
}
