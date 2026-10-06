// Scripted OpenAI-compatible chat-completions server for driving a real
// in-process OpenCode v2 host without a model. Each request is recorded; the
// script decides the reply (text and/or tool calls) from the request body.

export type ToolCall = { readonly name: string; readonly args: Record<string, unknown> }
export type Turn = { readonly text?: string; readonly toolCalls?: readonly ToolCall[] }
export type ChatRequest = {
  readonly model: string
  readonly messages: ReadonlyArray<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown }>
  readonly tools?: ReadonlyArray<{ type: "function"; function: { name: string; description?: string; parameters?: unknown } }>
}
export type Script = (request: ChatRequest, index: number) => Turn

export interface FakeLLM {
  readonly url: string
  readonly requests: ChatRequest[]
  setScript(script: Script): void
  stop(): void
}

let callCounter = 0

function chunk(id: string, delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

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
      const turn = script(body, index)
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
      out += `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "fake",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`
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
  (request?.tools ?? []).map((tool) => tool.function.name).sort()

/** Messages with role "tool" (tool results fed back to the model). */
export const toolResults = (request: ChatRequest | undefined) =>
  (request?.messages ?? []).filter((message) => message.role === "tool")
