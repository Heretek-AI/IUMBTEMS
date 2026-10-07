// Coarse MCP server (stdio, newline-delimited JSON-RPC 2.0) exposing the
// harness-neutral factory operations to harnesses without a native plugin and
// to headless runs. It has no approve, trust, waive or resume tool: those are
// human-only. Caller identity is the `agent` argument (or ES_AGENT), which the
// harness adapter sets per agent; over plain MCP it is ADVISORY, and the
// capability matrix says so.
import { esTools, Factory, gateRunner } from "@heretek-ai/es-core"
import { VERSION } from "./version.ts"

export const PROTOCOL_VERSION = "2025-06-18"

export interface McpOptions {
  readonly root: string
  readonly stateDir?: string
  readonly defaultAgent?: string
  readonly version?: string
}

type Json = Record<string, any>

export function createMcpServer(options: McpOptions) {
  const factory = new Factory(options.root, {
    gates: gateRunner(options.stateDir ? { stateDir: options.stateDir } : {}),
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
  })
  const tools = esTools({ root: options.root, factory, stateDir: options.stateDir ?? "" })
  const byName = new Map(tools.map((tool) => [tool.name.replace(/^es_/, ""), tool]))
  const listed = [...byName].map(([name, tool]) => ({
    name,
    description: `${tool.description}${name === "status" || name === "spec_validate" ? "" : " Pass your agent ID as `agent`."}`,
    inputSchema: {
      ...tool.input,
      properties: {
        ...(tool.input.properties as Json),
        agent: { type: "string", description: "Calling agent ID (e.g. es-programmer). Advisory over MCP." },
      },
    },
  }))

  async function handle(message: Json): Promise<Json | undefined> {
    const { id, method, params } = message
    if (id === undefined) return undefined // notification
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result })
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } })
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "epistemic-swarm", version: options.version ?? VERSION },
          instructions:
            "Epistemic Swarm factory operations. Approvals, trust, waivers and resume are human-only (TUI or `es` CLI) and have no MCP tool. The `agent` argument identifies the caller ADVISORY: the harness adapter, not this protocol, establishes it.",
        })
      case "ping":
        return reply({})
      case "tools/list":
        return reply({ tools: listed })
      case "tools/call": {
        const tool = byName.get(String(params?.name ?? ""))
        if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`)
        const { agent, ...input } = (params?.arguments ?? {}) as Json
        try {
          const text = await tool.execute(input, { agent: String(agent ?? options.defaultAgent ?? "mcp") })
          return reply({ content: [{ type: "text", text }] })
        } catch (error) {
          return reply({
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          })
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`)
    }
  }

  return { handle, tools: listed }
}

/** Serve on stdin/stdout until stdin closes. */
export async function serveStdio(options: McpOptions): Promise<void> {
  const server = createMcpServer(options)
  let buffer = ""
  const write = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`)
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    buffer += chunk
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message: Json
      try {
        message = JSON.parse(line)
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
        continue
      }
      const response = await server.handle(message)
      if (response) write(response)
    }
  }
}
