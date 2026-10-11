// Registry listing on the real host (#195.2, #228.2): every registry agent is
// registered with its hidden flag and mode; hidden seats are unlisted from the
// host's subagent menu (the model-visible agent listing) yet addressable by
// id; and a vanilla-baseline diff proves built-ins and defaults are untouched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS } from "@heretek-ai/es-core"
import { boot, type Harness, lastAgentRequest } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const hiddenIds = AGENTS.filter((agent) => agent.hidden).map((agent) => agent.id)
const agentOf = (h: Harness) => (h.opencode as any).agent
/** Per-boot host tmpdirs (config dir, project dir) differ between hosts; they
 *  are host-generated, never plugin input. Normalize them before diffing. */
const normalize = (value: unknown) =>
  value === undefined
    ? value
    : JSON.parse(JSON.stringify(value).replace(/\/tmp\/es-host(-config)?-[A-Za-z0-9]+/g, "/tmp/HOSTTMP"))
const list = async (h: Harness) =>
  (await agentOf(h).list({ location: { directory: h.directory } } as any))?.data as Array<{
    id: string
    mode: string
    hidden: boolean
    description: string
    permissions: unknown
    model?: unknown
  }>

describe("registry listing on the real host (#195)", () => {
  let h: Harness
  let clean: Harness
  let state: string

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-listing-state-"))
    ;[h, clean] = await Promise.all([
      boot({
        git: true,
        plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
        files: { "README.md": "# listing\n" },
      }),
      boot({ git: true, files: { "README.md": "# vanilla\n" } }),
    ])
    // Agent state is location-scoped and populated lazily: one session per
    // host before listing, or `agent.list` comes back empty.
    await h.run("hello", { agent: "factory" })
    await clean.run("hello")
  }, 180_000)
  afterAll(async () => {
    await Promise.all([h?.close(), clean?.close()].filter(Boolean))
    await rm(state, { recursive: true, force: true })
  })

  test("every registry agent is registered with its hidden flag and mode", async () => {
    const listed = await list(h)
    expect(listed.map((agent) => agent.id).sort()).toEqual(expect.arrayContaining(AGENTS.map((agent) => agent.id)))
    for (const spec of AGENTS) {
      const info = listed.find((agent) => agent.id === spec.id)
      expect([spec.id, info?.hidden, info?.mode]).toEqual([spec.id, spec.hidden, spec.mode])
    }
  }, 60_000)

  test("hidden seats are addressable by id (invocable, not absent)", async () => {
    for (const id of hiddenIds) {
      const info = await agentOf(h).get({ agentID: id, location: { directory: h.directory } } as any)
      expect([id, info?.data?.hidden]).toEqual([id, true])
    }
  }, 60_000)

  test("hidden seats are unlisted from a spawning seat's subagent menu", async () => {
    await h.run("hello", { agent: "factory" })
    const request = lastAgentRequest(h.llm.requests)
    const subagent = (request?.tools ?? []).find((tool) => tool.function.name === "subagent")
    expect(subagent).toBeDefined()
    // The factory can spawn hidden seats, so none may be named: everything it
    // may launch is hidden, and the host omits hidden agents from the menu.
    expect(subagent?.function.description ?? "").not.toContain("Available subagents:")
    for (const id of hiddenIds) expect([id, (subagent?.function.description ?? "").includes(id)]).toEqual([id, false])
  }, 60_000)

  test("the user agent's menu lists non-hidden subagents but no hidden seat", async () => {
    await h.run("hello", { agent: "build" })
    const request = lastAgentRequest(h.llm.requests)
    const subagent = (request?.tools ?? []).find((tool) => tool.function.name === "subagent")
    // Non-vacuous: the menu renders (built-in non-hidden subagents are
    // listed), yet no hidden seat leaks into it.
    expect(subagent?.function.description ?? "").toContain("Available subagents:")
    for (const id of hiddenIds) expect([id, (subagent?.function.description ?? "").includes(id)]).toEqual([id, false])
  }, 60_000)

  test("vanilla baseline: built-ins and defaults are untouched, our agents are purely additive", async () => {
    const [withPlugin, vanilla] = await Promise.all([list(h), list(clean)])
    const vanillaById = new Map(vanilla.map((agent) => [agent.id, agent]))
    expect(vanillaById.size).toBeGreaterThan(0)
    // Every vanilla agent is byte-equal on the fields the plugin could touch.
    for (const base of vanilla) {
      const info = withPlugin.find((agent) => agent.id === base.id)
      expect(info?.id).toBe(base.id)
      expect({
        mode: info?.mode,
        hidden: info?.hidden,
        description: normalize(info?.description),
        permissions: normalize(info?.permissions),
        model: info?.model,
      }).toEqual({
        mode: base.mode,
        hidden: base.hidden,
        description: normalize(base.description),
        permissions: normalize(base.permissions),
        model: base.model,
      })
    }
    // The default is unchanged (the host lists the selected default first).
    expect([vanilla[0]?.id, withPlugin[0]?.id]).toEqual(["build", "build"])
    // The only additions are exactly the registry ids.
    const added = withPlugin.map((agent) => agent.id).filter((id) => !vanillaById.has(id))
    expect(added.sort()).toEqual(AGENTS.map((agent) => agent.id).sort())
    // And the clean host knows none of our seats.
    await expect(agentOf(clean).get({ agentID: "factory" } as any)).rejects.toThrow("Agent not found")
  }, 60_000)
})
