import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { boot, directiveScript, type Harness, systemText } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const child = (name: string, args: Record<string, unknown> = {}) => `@@CHILD ${name} ${JSON.stringify(args)}@@`

describe("delegated children follow @@CHILD scripts (#34)", () => {
  let h: Harness
  beforeAll(async () => {
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { pr: "off" } }],
      files: { "README.md": "# demo\n" },
    })
  }, 60_000)
  afterAll(() => h?.close())

  test("the factory reaches a hidden seat through the host subagent tool", async () => {
    const prompt =
      `check the run ${child("es_status", {})} and report ` +
      call("subagent", {
        agent: "es-qa-functional",
        description: "check run status",
        prompt: `check the run ${child("es_status", {})} and report back`,
      })
    const { tools } = await h.run(`delegate ${prompt}`, { agent: "factory" })
    // The parent ran only its own CALL (the delegation); the CHILD line in its
    // own message was not consumed as a parent call.
    expect(tools.map((tool) => tool.name)).toEqual(["subagent"])
    expect(tools[0]?.status).toBe("completed")
    // The child's scripted es_status ran and its output came back through the
    // delegation result: no factory run exists in this fresh project.
    expect(tools[0]?.text).toContain("No factory run")
    // The child session itself hit the model with the QA seat's tools: a later
    // child request carries the es_status tool result.
    const qaRequests = h.llm.requests.filter((request) => /qa-functional/i.test(systemText(request)))
    expect(qaRequests.length).toBeGreaterThan(0)
    expect(qaRequests.some((request) => JSON.stringify(request).includes("No factory run"))).toBe(true)
  })
})
