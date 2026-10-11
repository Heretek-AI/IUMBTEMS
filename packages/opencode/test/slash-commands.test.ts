// Issue #198: every server slash command invoked on the real in-process v2
// host, asserting seat/verb routing (server.ts commands, not the TUI `es-*`
// palette set in tui.tsx, which tui.test.ts covers).
//
// FINDING (duplicate registration, bug filed): `research` is registered twice
// (server.ts deep-research flow vs report/coverage reader). The host command
// state is a Map keyed by name (`editor.set(definition.name, ...)`), so the
// LAST registration wins: both `/research` invocations below route to the
// report/coverage reader, and the deep-research flow is unreachable by name.
// Routing is intentionally NOT changed here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")

let h: Harness
let state: string
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-slash-commands-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# demo\n", ".gitignore": "node_modules/\n" },
  })
}, 120_000)
afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

async function invoke(name: string, text: string) {
  const session = await (h.opencode as any).sessions.create({ location: h.location } as any)
  const before = await (h.opencode as any).sessions.get({ sessionID: session.id } as any)
  await (h.opencode as any).sessions.command({ sessionID: session.id, name, text } as any)
  await (h.opencode as any).sessions.wait({ sessionID: session.id } as any)
  const after = await (h.opencode as any).sessions.get({ sessionID: session.id } as any)
  const context = await (h.opencode as any).sessions.context({ sessionID: session.id } as any)
  return { before: before?.agent as string | undefined, after: after?.agent as string | undefined, context }
}

const userTexts = (context: any[]): string[] =>
  context.filter((message) => message?.type === "user").map((message) => String(message.text ?? ""))
const syntheticTexts = (context: any[]): string[] =>
  context.filter((message) => message?.type === "synthetic").map((message) => String(message.text ?? ""))

describe("slash commands route to the right seat", () => {
  test("/grill switches to grill", async () => {
    const { after, context } = await invoke("grill", "my idea")
    expect(after).toBe("grill")
    expect(userTexts(context).join("\n")).toContain("Grill me on: my idea")
  }, 60_000)

  test("/brainstorm switches to brainstormer", async () => {
    const { after, context } = await invoke("brainstorm", "fast tests")
    expect(after).toBe("brainstormer")
    expect(userTexts(context).join("\n")).toContain("Brainstorm: fast tests")
  }, 60_000)

  test("/harvest switches to harvester", async () => {
    const { after, context } = await invoke("harvest", "teardown x")
    expect(after).toBe("harvester")
    expect(userTexts(context).join("\n")).toContain("Darkharvest: teardown x")
  }, 60_000)

  test("/design switches to designer", async () => {
    const { after, context } = await invoke("design", "acme app")
    expect(after).toBe("designer")
    expect(userTexts(context).join("\n")).toContain("Run the design interview. Product: acme app")
  }, 60_000)

  test("/scout switches to scout", async () => {
    const { after, context } = await invoke("scout", "test runner")
    expect(after).toBe("scout")
    expect(userTexts(context).join("\n")).toContain("Scout: test runner")
  }, 60_000)
})

describe("slash commands that answer verbatim (no seat switch)", () => {
  test("/factory with no run says to grill first", async () => {
    const { before, after, context } = await invoke("factory", "")
    expect(after).toBe(before)
    expect(syntheticTexts(context).join("\n")).toContain("No factory run here yet — run /grill first.")
  }, 60_000)

  test("/audit with no spend ceiling points at a terminal", async () => {
    const { before, after, context } = await invoke("audit", "src/x.ts")
    expect(after).toBe(before)
    expect(syntheticTexts(context).join("\n")).toContain("Audits run inside a factory run with a spend ceiling.")
  }, 60_000)

  test("/gates reports the gate summary", async () => {
    const { before, after, context } = await invoke("gates", "")
    expect(after).toBe(before)
    expect(syntheticTexts(context).join("\n")).toMatch(/^Gates (passed|failed):/m)
  }, 60_000)

  test("/lsp reports language servers", async () => {
    const { before, after, context } = await invoke("lsp", "")
    expect(after).toBe(before)
    expect(syntheticTexts(context).join("\n")).toContain("LSP is")
  }, 60_000)

  test("/hooks reports the hook bridge", async () => {
    const { before, after, context } = await invoke("hooks", "")
    expect(after).toBe(before)
    expect(syntheticTexts(context).join("\n")).toContain("Hook bridge:")
  }, 60_000)

  test("/status reports the factory state block", async () => {
    const { before, after, context } = await invoke("status", "")
    expect(after).toBe(before)
    expect(syntheticTexts(context).join("\n")).toContain("<factory-state>")
  }, 60_000)

  test("/config reports layers and config", async () => {
    const { before, after, context } = await invoke("config", "")
    expect(after).toBe(before)
    expect(syntheticTexts(context).join("\n")).toContain("Layers:")
  }, 60_000)
})

describe("/research duplicate registration: the last body wins", () => {
  test("/research with no args reads the report/coverage/sources", async () => {
    const { before, after, context } = await invoke("research", "")
    expect(after).toBe(before)
    const text = syntheticTexts(context).join("\n")
    expect(text).toContain("No research report yet (.factory/research/REPORT.md).")
    expect(text).toContain("Cached sources:")
  }, 60_000)

  test("/research deep args still reach the reader, not the deep flow (FINDING)", async () => {
    const { before, after, context } = await invoke("research", "deep what is foo --max-usd 5")
    // The deep-research body would switch to deep-researcher and begin a run;
    // the reader body wins instead: no switch, reader text.
    expect(after).toBe(before)
    expect(after).not.toBe("deep-researcher")
    const text = syntheticTexts(context).join("\n")
    expect(text).toContain("No research report yet (.factory/research/REPORT.md).")
    expect(text).toContain("Cached sources:")
  }, 60_000)
})
