// Scripted OpenAI-compatible chat-completions server for driving a real
// in-process OpenCode v2 host without a model. Each request is recorded; the
// script decides the reply (text and/or tool calls) from the request body.

export type ToolCall = { readonly name: string; readonly args: Record<string, unknown> }
export type Turn = {
  readonly text?: string
  readonly toolCalls?: readonly ToolCall[]
  /** Token usage reported for this turn (defaults to 10 in / 5 out). */
  readonly usage?: { readonly input: number; readonly output: number }
}
export type ChatRequest = {
  readonly model: string
  readonly messages: ReadonlyArray<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown }>
  readonly tools?: ReadonlyArray<{
    type: "function"
    function: { name: string; description?: string; parameters?: unknown }
  }>
}
export type Script = (request: ChatRequest, index: number) => Turn

export interface FakeLLM {
  readonly url: string
  readonly requests: ChatRequest[]
  setScript(script: Script): void
  stop(): void
}

let callCounter = 0

const frame = (id: string, choices: unknown[], extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fake", choices, ...extra })}\n\n`

const chunk = (id: string, delta: Record<string, unknown>, finish: string | null = null) =>
  frame(id, [{ index: 0, delta, finish_reason: finish }])

export function startFakeLLM(initial: Script = () => ({ text: "ok" })): FakeLLM {
  let script = initial
  const requests: ChatRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as ChatRequest
      const index = requests.length
      requests.push(body)
      let turn: Turn
      try {
        turn = script(body, index)
      } catch (error) {
        turn = { text: `script error: ${error instanceof Error ? error.message : String(error)}` }
      }
      const id = `chatcmpl-${index}`
      let out = chunk(id, { role: "assistant", content: "" })
      if (turn.text) out += chunk(id, { content: turn.text })
      turn.toolCalls?.forEach((call, i) => {
        out += chunk(id, {
          tool_calls: [
            {
              index: i,
              id: `call_${++callCounter}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        })
      })
      out += chunk(id, {}, turn.toolCalls?.length ? "tool_calls" : "stop")
      const usage = turn.usage ?? { input: 10, output: 5 }
      out += frame(id, [], {
        usage: {
          prompt_tokens: usage.input,
          completion_tokens: usage.output,
          total_tokens: usage.input + usage.output,
        },
      })
      out += "data: [DONE]\n\n"
      return new Response(out, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    setScript: (next) => {
      script = next
    },
    stop: () => server.stop(true),
  }
}

/** Tool names advertised to the model in a recorded request. */
export const advertised = (request: ChatRequest | undefined) =>
  (request?.tools ?? []).map((tool) => tool.function.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** Messages with role "tool" (tool results fed back to the model). */
export const toolResults = (request: ChatRequest | undefined) =>
  (request?.messages ?? []).filter((message) => message.role === "tool")
