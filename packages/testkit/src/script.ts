// Directive-driven fake-LLM script. A user prompt embeds tool calls as
//   @@CALL name {json}@@   (repeatable)
// The first model request after a user message emits those calls; once tool
// results come back the model answers with "done:" plus the tool outputs.
// A delegated child session (the host's subagent tool) carries its own
// directives as @@CHILD name {json}@@ inside the prompt its parent sent —
// the child's user text starts with "You are a subagent spawned by another
// session." The CHILD tag keeps the parent's @@CALL script from consuming
// the child's calls: the parent parses CALL, the child parses CHILD.
// Test convention: the parent's subagent prompt embeds the child's script,
// e.g. @@CALL subagent {"agent":"es-qa-functional","prompt":"qa it @@CHILD
// es_qa_verdict {...}@@ done"}@@.
import type { ChatRequest, ToolCall, Turn } from "./fake-llm.ts"

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: any) => part?.text ?? "").join("")
      : JSON.stringify(content ?? "")

export function directives(source: string, tag = "CALL"): ToolCall[] {
  const calls: ToolCall[] = []
  const open = `@@${tag} `
  let at = 0
  // Brace-balanced scan (JSON-string aware): a parent's @@CALL subagent args
  // may embed a child's @@CHILD directives in its prompt string, so a naive
  // non-greedy `\{.*?\}` would stop at the child's first closing brace and
  // hand JSON.parse a truncated object.
  for (;;) {
    const start = source.indexOf(open, at)
    if (start < 0) return calls
    const nameStart = start + open.length
    const space = source.indexOf(" ", nameStart)
    if (space < 0) return calls
    const name = source.slice(nameStart, space)
    if (!name) {
      at = space + 1
      continue
    }
    const jsonStart = source.indexOf("{", space)
    if (jsonStart < 0) return calls
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = jsonStart; i < source.length; i++) {
      const ch = source[i]!
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
      } else if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) return calls
    if (source.slice(end + 1, end + 3) !== "@@") {
      at = jsonStart + 1
      continue
    }
    calls.push({ name, args: JSON.parse(source.slice(jsonStart, end + 1)) as Record<string, unknown> })
    at = end + 3
  }
}

export function directiveScript(request: ChatRequest): Turn {
  const messages = request.messages
  // Host notices (e.g. "Code Mode tool catalog has changed") arrive as user-role
  // messages mid-turn; anchor on the last user message that carries real input.
  const isNotice = (content: unknown) => {
    const body = text(content).trim()
    return !body.includes("@@CALL") && (/catalog has changed/.test(body) || body.startsWith("<system-reminder>"))
  }
  if (isTitleRequest(request)) return { text: "Test session" }
  const lastUser = messages.findLastIndex((message) => message.role === "user" && !isNotice(message.content))
  const after = messages.slice(lastUser + 1)
  const userText = lastUser >= 0 ? text(messages[lastUser]!.content) : ""
  const results = after.filter((message) => message.role === "tool").map((message) => text(message.content))
  // A delegated child session is recognised by the host's subagent prefix on
  // its user text; it runs its own @@CHILD directives (see the header), so a
  // parent script never consumes them and sibling tests never see them.
  const child = userText.startsWith("You are a subagent spawned by another session.")
  const calls = directives(userText, child ? "CHILD" : "CALL")
  // Default: one call per model turn, in order (like a careful agent). "@@PARALLEL@@"
  // emits every call in a single turn, as models do for independent calls.
  if (/@@PARALLEL@@/.test(userText)) {
    if (results.length > 0) return { text: `done: ${results.join(" | ")}` }
    if (calls.length > 0) return { toolCalls: calls }
  } else if (results.length < calls.length) return { toolCalls: [calls[results.length]!] }
  if (results.length > 0) return { text: `done: ${results.join(" | ")}` }
  return { text: `plain reply to: ${userText.slice(0, 80)}` }
}

/** The host's background title-generation request (not part of the agent loop). */
export const isTitleRequest = (request: ChatRequest | undefined) =>
  (request?.messages ?? []).some(
    (message) => message.role === "system" && /title generator/i.test(text(message.content)),
  )

/** The most recent agent-loop request (skips title generation). */
export const lastAgentRequest = (requests: readonly ChatRequest[]) =>
  [...requests].reverse().find((request) => !isTitleRequest(request))

export const systemText = (request: ChatRequest | undefined) =>
  (request?.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")

export const allText = (request: ChatRequest | undefined) => JSON.stringify(request?.messages ?? [])
