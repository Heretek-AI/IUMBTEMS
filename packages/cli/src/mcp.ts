// Coarse MCP server (stdio, newline-delimited JSON-RPC 2.0) exposing the
// harness-neutral factory operations to harnesses without a native plugin and
// to headless runs. It has no approve, trust, waive or resume tool: those are
// human-only. Caller identity is PINNED, never piped: the harness adapter sets
// one agent id per server in its environment (`ES_MCP_AGENT`, else the legacy
// `ES_AGENT`, else the `defaultAgent` option — all written by the human in the
// adapter config), and the per-call `agent` argument is ignored. Without an
// adapter identity the caller is "mcp", which maps to no seat, so every
// seat-checked tool refuses. Only a registry agent id (`factory`,
// `es-manager`, `es-programmer`, …) holds a seat: any other pinned string is
// still the caller, but a seat-less one, refused the same way as "mcp".
import { checkStopFile, stateDir as defaultStateDir, esTools, Factory, gateRunner } from "@heretek-ai/es-core"
import { VERSION } from "./version.ts"

export const PROTOCOL_VERSION = "2025-06-18"

export interface McpOptions {
  readonly root: string
  readonly stateDir?: string
  readonly defaultAgent?: string
  readonly version?: string
  /** Server environment for the pinned identity (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv
}

type Json = Record<string, any>

export function createMcpServer(options: McpOptions) {
  const env = options.env ?? process.env
  // Pinned at construction: the adapter's environment, never the caller's
  // arguments. An agent piping JSON-RPC into this server cannot claim a seat.
  // Library consumers get the same order as the CLI wrapper: the adapter's
  // ES_MCP_AGENT wins, then the legacy ES_AGENT, then the defaultAgent option.
  const caller = env.ES_MCP_AGENT || env.ES_AGENT || options.defaultAgent || "mcp"
  const factory = new Factory(options.root, {
    gates: gateRunner(options.stateDir ? { stateDir: options.stateDir } : {}),
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
  })
  const tools = esTools({ root: options.root, factory, stateDir: options.stateDir ?? defaultStateDir() })
  const byName = new Map(tools.map((tool) => [tool.name.replace(/^es_/, ""), tool]))
  const listed = [...byName].map(([name, tool]) => ({
    name,
    description: `${tool.description}${name === "status" || name === "spec_validate" ? "" : " Caller identity is pinned by the adapter (ES_MCP_AGENT, else ES_AGENT, else the default agent); a per-call `agent` argument is accepted but ignored."}`,
    inputSchema: {
      ...tool.input,
      properties: {
        ...(tool.input.properties as Json),
        agent: {
          type: "string",
          description:
            "Ignored: the caller is the adapter's pinned ES_MCP_AGENT (else ES_AGENT, else the default agent), never this argument.",
        },
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
            "Epistemic Swarm factory operations. Approvals, trust, waivers and resume are human-only (TUI or `es` CLI) and have no MCP tool. Caller identity is pinned: the adapter sets ES_MCP_AGENT in this server's environment (one server per agent), else the legacy ES_AGENT, else the default agent; without any of them the caller is `mcp`, which holds no seat, so seat-checked tools refuse. A per-call `agent` argument is ignored.",
        })
      case "ping":
        return reply({})
      case "tools/list":
        return reply({ tools: listed })
      case "tools/call": {
        const tool = byName.get(String(params?.name ?? ""))
        if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`)
        const { agent: _ignored, ...input } = (params?.arguments ?? {}) as Json
        try {
          // STOP and HALTED hold on the MCP surface too (#227): the
          // kill-switch refuses every call; a halted run refuses everything
          // but status, mirroring the OpenCode host policy.
          const stop = await checkStopFile(options.root)
          if (stop.stopped)
            throw new Error(
              `The factory is stopped (.factory/STOP: ${stop.reason}). A human must remove it and resume.`,
            )
          if (tool.name !== "es_status") {
            const state = await factory.read().catch(() => undefined)
            if (state?.stage === "HALTED")
              throw new Error(`The factory is halted: ${state.halt?.reason}. Stop and report; a human must resume.`)
          }
          const text = await tool.execute(input, { agent: caller })
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
