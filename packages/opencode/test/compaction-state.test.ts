// Issue #198: compaction injects the factory-state block for factory seats
// only (session.ts). A factory seat's post-compaction request carries
// "Preserve this factory state" plus the <factory-state> block; a non-factory
// agent (the user's own build agent) compacts with neither.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness, systemText } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")

let h: Harness
let state: string
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-compaction-"))
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

async function compactTexts(agent: string | undefined): Promise<string[]> {
  const options = agent === undefined ? {} : { agent }
  const { sessionID } = await h.run("hello", options)
  const before = h.llm.requests.length
  await (h.opencode as any).sessions.compact({ sessionID } as any)
  await (h.opencode as any).sessions.wait({ sessionID } as any)
  return h.llm.requests.slice(before).map((request) => systemText(request))
}

describe("compaction carries the factory state for factory seats only", () => {
  test("a factory seat keeps the state block across compaction", async () => {
    const texts = await compactTexts("factory")
    expect(texts.length).toBeGreaterThan(0)
    const kept = texts.filter(
      (text) => text.includes("Preserve this factory state") && text.includes("<factory-state>"),
    )
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.join("\n")).toContain("<factory-state>No factory run in this project.")
  }, 60_000)

  test("a non-factory agent compacts without the state block", async () => {
    const texts = await compactTexts(undefined)
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) {
      expect(text).not.toContain("Preserve this factory state")
      expect(text).not.toContain("<factory-state>")
    }
  }, 60_000)
})
