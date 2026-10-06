// M0 spike: each test proves (or refutes) one extension-point assumption of the
// 1.0 design against a real in-process OpenCode v2 host (published
// @opencode/sdk 2.0.24) driven by a scripted fake model. Results are recorded
// in RESULTS.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { advertised, type ChatRequest } from "./fake-llm"
import { boot, type Harness } from "./host"
import { PROBE_SUMMARY, PROBE_SYSTEM } from "./plugins/effect-probe/index"
import { allText, directiveScript, systemText } from "./script"

const here = import.meta.dir
const SEAT_SYSTEM = "You are the hidden probe seat."

// Child sessions of the hidden seat try to nest another subagent.
const script = (request: ChatRequest, index: number) => {
  if (systemText(request).includes(SEAT_SYSTEM)) {
    const results = request.messages.filter((message) => message.role === "tool")
    if (results.length === 0)
      return { toolCalls: [{ name: "subagent", args: { agent: "es-seat", description: "nested", prompt: "nested" } }] }
    return { text: `child saw: ${JSON.stringify(results.map((message) => message.content))}` }
  }
  return directiveScript(request)
}

let h: Harness

beforeAll(async () => {
  h = await boot({
    script,
    plugins: [path.join(here, "plugins/effect-probe"), path.join(here, "plugins/promise-probe")],
    config: {
      mcp: { servers: { probe: { type: "local", command: ["bun", path.join(here, "mcp-probe.ts")] } } },
      lsp: { typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts"] } },
    },
    files: { "hello.txt": "hello file\n", "DENYME.txt": "TOPSECRET-42\n", "BLOCKME.txt": "BLOCKED-FILE-BODY\n" },
  })
  for (let i = 0; i < 80; i++) {
    const list: any = await h.opencode.mcp.list({ location: h.location } as any)
    if (JSON.stringify(list).includes('"connected"')) break
    await Bun.sleep(100)
  }
}, 60000)

afterAll(async () => {
  await h?.close()
})

const lastRequest = () => h.llm.requests.at(-1)
const call = (name: string, args: Record<string, unknown>) => `@@CALL ${name} ${JSON.stringify(args)}@@`

describe("M0", () => {
  test("A1 tool.execute.before (Effect API) blocks a plugin tool with Tool.Error", async () => {
    const { context } = await h.run(`go ${call("es_echo", { text: "BLOCKME" })}`)
    const text = allText(lastRequest())
    expect(text).toContain("blocked by es hook: es_echo")
    expect(JSON.stringify(context)).not.toContain("echo:BLOCKME")
    expect(JSON.stringify(context)).toContain("done:")
  })

  test("A2 tool.execute.before (Effect API) blocks a host-native tool (read)", async () => {
    // Host input repair runs before plugin hooks, so the marker must be in a real field.
    await h.run(`go ${call("read", { path: "BLOCKME.txt" })}`)
    const text = allText(lastRequest())
    expect(text).toContain("blocked by es hook: read")
    expect(text).not.toContain("BLOCKED-FILE-BODY")
  })

  test("A3 unblocked host-native read still works (control)", async () => {
    await h.run(`go ${call("read", { path: "hello.txt" })}`)
    expect(allText(lastRequest())).toContain("hello file")
  })

  test("A4 tool.execute.before (Promise API) throw: blocks, but surfaces as a defect", async () => {
    const { context } = await h.run(`go ${call("es_p_echo", { text: "PBLOCK" })}`)
    const dump = JSON.stringify(context)
    expect(dump).not.toContain("p-echo:PBLOCK")
    // Record how the session surfaced it (graceful tool error vs failed step).
    const graceful = allText(lastRequest()).includes("promise hook block")
    console.log("A4 promise-hook-block graceful-to-model:", graceful, "| context types:", context.map((m: any) => m.type).join(","))
  })

  test("A5 Effect tool returning Tool.Error is fed back to the model", async () => {
    await h.run(`go ${call("es_fail", {})}`)
    expect(allText(lastRequest())).toContain("es_fail refused")
  })

  test("A6 Promise tool throwing: record surfacing", async () => {
    const { context } = await h.run(`go ${call("es_p_throw", {})}`)
    const graceful = allText(lastRequest()).includes("es_p_throw refused")
    console.log("A6 promise-tool-throw graceful-to-model:", graceful, "| context types:", context.map((m: any) => m.type).join(","))
  })

  test("A7 permission.evaluate hook turns allow into deny with a message", async () => {
    await h.run(`go ${call("read", { path: "DENYME.txt" })}`)
    const text = allText(lastRequest())
    expect(text).not.toContain("TOPSECRET-42")
    expect(text).toContain("permission.rejected")
    expect(text).toContain("denied by es permission hook")
  })

  test("A8 agent.transform wildcard-deny hides tools, MCP tools and skills per agent", async () => {
    await h.run("hello build")
    const build = lastRequest()
    expect(advertised(build)).toContain("es_gated")
    expect(systemText(build)).toContain("tools.probe.alpha")
    expect(systemText(build)).toContain("tools.probe.beta")
    expect(systemText(build)).toContain("<id>es-hidden</id>")

    await h.run("hello scoped", { agent: "es-scoped" })
    const scoped = lastRequest()
    expect(advertised(scoped)).not.toContain("es_gated")
    expect(systemText(scoped)).toContain("tools.probe.alpha")
    expect(systemText(scoped)).not.toContain("tools.probe.beta")
    expect(systemText(scoped)).toContain("<id>es-visible</id>")
    expect(systemText(scoped)).not.toContain("<id>es-hidden</id>")
  })

  test("A9 hidden subagent is unlisted but invocable; nested subagent hits depth limit 1", async () => {
    await h.run("list subagents")
    const subagentTool = lastRequest()?.tools?.find((tool) => tool.function.name === "subagent")
    expect(subagentTool?.function.description ?? "").not.toContain("es-seat")
    await h.run(`go ${call("subagent", { agent: "es-seat", description: "probe seat", prompt: "child task" })}`)
    const text = allText(lastRequest())
    expect(text).toContain('state=\\"completed\\"')
    expect(text).toContain("Subagent depth limit reached (1)")
  })

  test("A10 websearch.transform registers the default host websearch provider", async () => {
    await h.run(`go ${call("websearch", { query: "factory gates" })}`)
    const text = allText(lastRequest())
    expect(text).toContain("ES-SEARCH-CONTENT")
    expect(text).toContain("result for factory gates")
  })

  test("A11 session context hook injects a system block", async () => {
    await h.run("hello again")
    expect(systemText(lastRequest())).toContain(PROBE_SYSTEM)
  })

  test("A12 session compaction hook supplies the summary without a model call", async () => {
    const { sessionID } = await h.run("something to compact")
    const before = h.llm.requests.length
    await h.opencode.sessions.compact({ sessionID } as any)
    await h.opencode.sessions.wait({ sessionID } as any)
    const context = await h.opencode.sessions.context({ sessionID } as any)
    expect(JSON.stringify(context)).toContain(PROBE_SUMMARY)
    expect(h.llm.requests.length).toBe(before)
  })

  test("A13 command.transform registers a slash command that runs plugin code", async () => {
    const commands: any = await h.opencode.command.list({ location: h.location } as any)
    expect(JSON.stringify(commands)).toContain("es-probe")
    const session: any = await h.opencode.sessions.create({ location: h.location } as any)
    await h.opencode.sessions.command({ sessionID: session.id, name: "es-probe", text: "" } as any)
    await h.opencode.sessions.wait({ sessionID: session.id } as any)
    await Bun.sleep(200)
    const context = await h.opencode.sessions.context({ sessionID: session.id } as any)
    expect(JSON.stringify(context)).toContain("ES-COMMAND-RAN")
  })

  test("A14 shell.create.before rewrites the command", async () => {
    await h.run(`go ${call("shell", { command: "echo ES_REWRITE" })}`)
    expect(allText(lastRequest())).toContain("rewritten-by-es")
  })

  test("A15 question tool raises a form a client can answer", async () => {
    const session: any = await h.opencode.sessions.create({ location: h.location } as any)
    const question = {
      questions: [
        { question: "Proceed?", header: "Proceed", options: [{ label: "Yes", description: "go" }, { label: "No", description: "stop" }] },
      ],
    }
    await h.opencode.sessions.prompt({ sessionID: session.id, text: `ask ${call("question", question)}` } as any)
    let forms: any[] = []
    for (let i = 0; i < 100 && forms.length === 0; i++) {
      await Bun.sleep(50)
      forms = ((await h.opencode.sessions.form.list({ sessionID: session.id } as any)) as any) ?? []
      if (!Array.isArray(forms)) forms = (forms as any).data ?? []
    }
    expect(forms.length).toBe(1)
    await h.opencode.sessions.form.reply({ sessionID: session.id, formID: forms[0].id, answer: { q0: "Yes" } } as any)
    await h.opencode.sessions.wait({ sessionID: session.id } as any)
    expect(allText(lastRequest())).toContain("Yes")
  })

  test("A16 lsp config key is accepted and readable via the config API (not via plugin ctx)", async () => {
    const config: any = await h.opencode.config.get({ location: h.location } as any)
    expect(JSON.stringify(config)).toContain("typescript-language-server")
  })
})
