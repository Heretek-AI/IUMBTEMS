// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0) exposing two tools.
const tools = [
  { name: "alpha", description: "probe alpha", inputSchema: { type: "object", properties: {} } },
  { name: "beta", description: "probe beta", inputSchema: { type: "object", properties: {} } },
]
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n")
let buffer = ""
process.stdin.on("data", (data) => {
  buffer += data.toString()
  let index: number
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    if (msg.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "probe", version: "0.0.0" },
        },
      })
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } })
    else if (msg.method === "tools/call")
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `called ${msg.params.name}` }] } })
    else send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
