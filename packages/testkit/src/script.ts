// Directive-driven fake-LLM script. A user prompt embeds tool calls as
//   @@CALL name {json}@@   (repeatable)
// The first model request after a user message emits those calls; once tool
// results come back the model answers with "done:" plus the tool outputs.
// A subagent child session is recognised by its system prompt; it can carry
// its own directives via @@CHILD name {json}@@ in the parent's prompt.
import type { ChatRequest, ToolCall, Turn } from "./fake-llm.ts"

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: any) => part?.text ?? "").join("")
      : JSON.stringify(content ?? "")

export function directives(source: string, tag = "CALL"): ToolCall[] {
  const calls: ToolCall[] = []
  const pattern = new RegExp(`@@${tag} (\\S+) (\\{.*?\\})@@`, "gs")
  for (const match of source.matchAll(pattern)) calls.push({ name: match[1]!, args: JSON.parse(match[2]!) })
  return calls
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
  const calls = directives(userText)
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
