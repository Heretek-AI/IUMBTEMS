// Allowed-path `patch` for seats (#220.2). The v2 host has no `patch`
// permission action: its patch tool asserts `edit` once, with every target of
// the patch (add, update, delete and move) as the resources. The seat matrix
// for a patch is therefore the `edit` branch of the evaluate hook, proven here
// on the hook itself and end to end on the real host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { createPolicyHooks } from "../src/policy.ts"
import type { Runtime } from "../src/runtime.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const exists = (file: string) => Bun.file(file).exists()

let root: string
let state: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-patch-scope-"))
  state = await mkdtemp(path.join(tmpdir(), "es-patch-scope-state-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const runtime = () =>
  ({
    root,
    factory: { read: async () => undefined },
    policy: async () => ({ root, stateDir: state }),
  }) as unknown as Runtime

const patchText = (...sections: string[]) => ["*** Begin Patch", ...sections, "*** End Patch"].join("\n")

describe("before: every patch target is checked at the tool call (#220.2)", () => {
  const before = (agent: string, text: string) =>
    createPolicyHooks(runtime()).before({ tool: "patch", agent, id: "1", input: { patchText: text } })

  test("a patch whose targets are all inside the seat's scope passes", async () => {
    await expect(
      before("es-manager", patchText("*** Add File: docs/plan.md", "+# plan", "*** Delete File: README.md")),
    ).resolves.toBeUndefined()
  })

  test("an out-of-scope add, delete or move target refuses the call", async () => {
    for (const section of [
      ["*** Add File: src/escape.ts", "+export {}"],
      ["*** Delete File: src/escape.ts"],
      ["*** Update File: docs/plan.md", "*** Move to: src/escape.ts", "@@", "-a", "+b"],
    ])
      await expect(before("es-manager", patchText("*** Add File: docs/ok.md", "+ok", ...section))).rejects.toThrow(
        'refused "src/escape.ts"',
      )
  })

  test("a control-file target refuses the call for a seat and for the user's own agent", async () => {
    for (const agent of ["es-manager", "build"])
      await expect(before(agent, patchText("*** Add File: .factory/approvals/spec.json", "+{}"))).rejects.toThrow(
        "is a factory control file",
      )
  })

  test("the user's own agent patches ordinary paths", async () => {
    await expect(before("build", patchText("*** Add File: src/app.ts", "+export {}"))).resolves.toBeUndefined()
  })
})

describe("evaluate: the edit permission a host patch asks for (#220.2)", () => {
  const evaluate = async (agent: string, action: string, resources: readonly string[]) => {
    const hooks = createPolicyHooks(runtime())
    // The host's verdict for a seat with a write scope: no `edit` rule, so it asks.
    const event: Parameters<typeof hooks.evaluate>[0] = { agent, action, resources, effect: "ask" }
    await hooks.evaluate(event)
    return event
  }

  test("every target inside the seat's scope: the seat's patch is allowed, never left asking", async () => {
    const event = await evaluate("es-manager", "edit", ["docs/plan.md", "README.md", ".factory/notes/n.md"])
    expect(event.effect).toBe("allow")
    expect(event.message).toBeUndefined()
  })

  test("one target outside the scope denies the whole patch, with that target's reason", async () => {
    const event = await evaluate("es-manager", "edit", ["docs/plan.md", "src/escape.ts"])
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("src/escape.ts")
  })

  test("a control-file target denies the patch for a seat and for the user's own agent", async () => {
    for (const agent of ["es-manager", "build"]) {
      const event = await evaluate(agent, "edit", ["docs/plan.md", ".factory/gates.json"])
      expect([agent, event.effect]).toEqual([agent, "deny"])
    }
  })

  test("a seat's own file is allowed and its sibling's is not (research alpha/beta)", async () => {
    expect((await evaluate("es-research-alpha", "edit", [".factory/research/alpha.md"])).effect).toBe("allow")
    expect((await evaluate("es-research-alpha", "edit", [".factory/research/beta.md"])).effect).toBe("deny")
  })

  test("the user's own agent keeps the host's ask on ordinary paths", async () => {
    expect((await evaluate("build", "edit", ["docs/plan.md", "src/app.ts"])).effect).toBe("ask")
  })

  test("a `patch` action the host does not emit fails closed for a seat", async () => {
    const event = await evaluate("es-manager", "patch", ["docs/plan.md"])
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("cannot wait for a human approval")
  })
})

describe("a seat's patch on the real host (#220.2)", () => {
  // The host offers `patch` only to a model whose id contains `gpt-` (and
  // takes `edit`/`write` away from it); the default scripted model never sees
  // the tool, so a patch leg there proves the host's refusal, not our policy.
  const host = (model?: string) =>
    boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# demo\n", ".gitignore": "node_modules/\n" },
      ...(model ? { model } : {}),
    })
  let h: Harness
  beforeAll(async () => {
    h = await host("gpt-scripted")
  }, 60_000)
  afterAll(() => h?.close())

  const patch = (...sections: string[]) => call("patch", { patchText: patchText(...sections) })
  const outcome = async (agent: string, prompt: string) => {
    const { tools } = await h.run(`go ${prompt}`, { agent })
    expect(tools).toHaveLength(1)
    return { status: `${tools[0]?.name}:${tools[0]?.status}`, text: tools[0]?.text ?? "" }
  }

  test("the manager's patch inside factory-docs lands, with no approval prompt", async () => {
    const done = await outcome(
      "es-manager",
      patch("*** Add File: docs/plan.md", "+# plan", "*** Add File: .factory/notes/n.md", "+note"),
    )
    expect(done.status).toBe("patch:completed")
    expect(await readFile(path.join(h.directory, "docs/plan.md"), "utf8")).toBe("# plan\n")
    expect(await readFile(path.join(h.directory, ".factory/notes/n.md"), "utf8")).toBe("note\n")
  })

  test("a research seat patches its own notes and is refused the dossier", async () => {
    const own = await outcome("es-research-alpha", patch("*** Add File: .factory/research/alpha.md", "+# a"))
    expect(own.status).toBe("patch:completed")
    expect(await readFile(path.join(h.directory, ".factory/research/alpha.md"), "utf8")).toBe("# a\n")
    const dossier = await outcome("es-research-alpha", patch("*** Add File: .factory/research/dossier.json", "+{}"))
    expect(dossier.status).toBe("patch:error")
    expect(dossier.text).toContain("is a factory control file")
    expect(await exists(path.join(h.directory, ".factory/research/dossier.json"))).toBe(false)
  })

  test("one out-of-scope target refuses the whole patch: the in-scope file is not written either", async () => {
    const mixed = await outcome(
      "es-manager",
      patch("*** Add File: docs/mixed.md", "+ok", "*** Add File: src/escape.ts", "+export {}"),
    )
    expect(mixed.status).toBe("patch:error")
    expect(mixed.text).toContain('refused "src/escape.ts"')
    expect(await exists(path.join(h.directory, "docs/mixed.md"))).toBe(false)
    expect(await exists(path.join(h.directory, "src/escape.ts"))).toBe(false)
  })

  test("a move out of the scope is refused and the source stays put", async () => {
    const moved = await outcome(
      "es-manager",
      patch("*** Update File: README.md", "*** Move to: src/README.md", "@@", "-# demo", "+# moved"),
    )
    expect(moved.status).toBe("patch:error")
    expect(moved.text).toContain('refused "src/README.md"')
    expect(await readFile(path.join(h.directory, "README.md"), "utf8")).toBe("# demo\n")
    expect(await exists(path.join(h.directory, "src/README.md"))).toBe(false)
  })

  test("a read-only seat's patch is refused by its seat, not by a missing tool", async () => {
    const qa = await outcome("es-qa-functional", patch("*** Add File: docs/qa.md", "+# qa"))
    expect(qa.status).toBe("patch:error")
    expect(qa.text).toContain("is read-only")
    expect(await exists(path.join(h.directory, "docs/qa.md"))).toBe(false)
  })

  test("a control-file patch is refused by the policy for a seat and for the user's own agent", async () => {
    for (const agent of ["es-manager", "build"]) {
      const denied = await outcome(agent, patch("*** Add File: .factory/waivers/w.json", "+{}"))
      expect([agent, denied.status]).toEqual([agent, "patch:error"])
      expect(denied.text).toContain("is a factory control file")
    }
    expect(await exists(path.join(h.directory, ".factory/waivers/w.json"))).toBe(false)
    // The user's own agent still patches ordinary paths: the refusal above is the policy's.
    const user = await outcome("build", patch("*** Add File: docs/user.md", "+# user"))
    expect(user.status).toBe("patch:completed")
  })

  test("the default scripted model is never offered patch (why these tests name a gpt- model)", async () => {
    const scripted = await host()
    try {
      const { tools } = await scripted.run(`go ${patch("*** Add File: docs/plan.md", "+# plan")}`, {
        agent: "es-manager",
      })
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["patch:error"])
      expect(tools[0]?.text).toContain("Tool is not available for this request: patch")
    } finally {
      await scripted.close()
    }
  }, 60_000)
})
