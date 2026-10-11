// Seat spawn rules on the real host (#195.2): every hidden seat launches from
// an allowed parent (proving "invocable only from allowed parents" positively)
// and is refused from a disallowed one. The child is verified to run as the
// requested seat through the host's own session record.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS, agentSpec } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const child = (name: string, args: Record<string, unknown> = {}) => `@@CHILD ${name} ${JSON.stringify(args)}@@`

const hiddenSeats = AGENTS.filter((agent) => agent.hidden)
/** A parent the registry allows to launch `seat` (factory wherever possible). */
const allowedParent = (seat: string) => {
  const parents = AGENTS.filter((agent) => agent.spawns.includes(seat)).map((agent) => agent.id)
  if (parents.includes("factory")) return "factory"
  return parents[0]!
}
/** A seat parent the registry never allows to launch anything. */
const DISALLOWED_PARENT = "es-qa-functional"

const childPrompt = (seat: string) =>
  agentSpec(seat)?.tools.includes("es_status") ? `check the run ${child("es_status", {})} and report back` : "reply ok"

const childSessionOf = (text: string) => /sessionID="([^"]+)"/.exec(text)?.[1]

describe("seat spawn rules on the real host (#195)", () => {
  let h: Harness
  let state: string

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-spawn-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# spawns\n" },
    })
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  describe("an allowed parent may launch the seat", () => {
    for (const seat of hiddenSeats) {
      const parent = allowedParent(seat.id)
      test(`${parent} launches ${seat.id}`, async () => {
        const { tools } = await h.run(
          `delegate ${call("subagent", { agent: seat.id, description: "seat check", prompt: childPrompt(seat.id) })}`,
          { agent: parent },
        )
        expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:completed"])
        if (agentSpec(seat.id)?.tools.includes("es_status")) expect(tools[0]?.text).toContain("No factory run")
        // The host ran the child as the requested seat, parented to the launcher.
        const sessionID = childSessionOf(tools[0]?.text ?? "")
        expect(sessionID).toBeDefined()
        const info: any = await (h.opencode as any).sessions.get({ sessionID } as any)
        expect(info?.agent).toBe(seat.id)
      }, 30_000)
    }
  })

  describe("a disallowed parent is refused", () => {
    for (const seat of hiddenSeats) {
      test(`${DISALLOWED_PARENT} cannot launch ${seat.id}`, async () => {
        const { tools } = await h.run(
          `delegate ${call("subagent", { agent: seat.id, description: "escape", prompt: "escape" })}`,
          { agent: DISALLOWED_PARENT },
        )
        expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:error"])
      }, 30_000)
    }
  })
})
