// Real-host tests: the plugin is loaded by an in-process OpenCode v2 host
// (published @opencode/sdk) from disk, driven by a scripted fake model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  bwrapAvailable,
  commandSetHash,
  Factory,
  factoryLayout,
  gateRunner,
  HookEngine,
  type HumanSigner,
  loadGatesConfig,
  pendingApprovals,
  recordApproval,
  researchSourcesDir,
  SourceCache,
  sealHumanKey,
  trustProject,
  unlockHumanKey,
  writeJson,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness, lastAgentRequest, systemText } from "@heretek-ai/es-testkit"
import { EsRpc } from "../src/rpc-def.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

let state: string
let signer: HumanSigner
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-plugin-state-"))
  await sealHumanKey("test-passphrase-1234", state)
  signer = await unlockHumanKey("test-passphrase-1234", state)
})
afterAll(() => rm(state, { recursive: true, force: true }))

async function host(files: Record<string, string> = {}): Promise<Harness> {
  return boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# demo\n", ".gitignore": "node_modules/\n", ...files },
  })
}

const rpcFor = (h: Harness) => (h.opencode as any).rpc(EsRpc)
const where = (h: Harness) => ({ location: h.location })
const exists = (file: string) => Bun.file(file).exists()

describe("integrity on the real host", () => {
  let h: Harness
  beforeAll(async () => {
    h = await host()
  }, 60_000)
  afterAll(() => h?.close())

  test("no agent tool can grant an approval", async () => {
    const { tools } = await h.run(`go ${call("es_approve", { stage: "spec", approvedBy: "me" })}`)
    expect(tools[0]?.status).toBe("error")
    const advertised = h.llm.requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.function.name))
    expect(advertised).not.toContain("es_approve")
  })

  test("control files are denied for write (relative and absolute), patch and shell", async () => {
    const target = path.join(h.directory, ".factory/approvals/spec.json")
    const attempts = [
      call("write", { path: ".factory/approvals/spec.json", content: "{}" }),
      call("write", { path: target, content: "{}" }),
      call("write", { path: "docs/../.factory/gates.json", content: "{}" }),
      call("patch", { patchText: "*** Begin Patch\n*** Add File: .factory/waivers/w.json\n+{}\n*** End Patch" }),
      call("shell", { command: "echo {} > .factory/approvals/spec.json" }),
      call("shell", { command: "es approve spec" }),
    ]
    const { tools } = await h.run(`attack ${attempts.join(" ")}`)
    expect(tools).toHaveLength(attempts.length)
    for (const outcome of tools) expect(`${outcome.name}:${outcome.status}`).toBe(`${outcome.name}:error`)
    expect(await exists(target)).toBe(false)
    expect(await exists(path.join(h.directory, ".factory/waivers/w.json"))).toBe(false)
  })

  test("a research seat cannot forge a cached source, and the user's agent cannot either", async () => {
    // The name is the sha256 of the content, so the forgery would pass the
    // cache's tamper check; only the deny-write policy stops it.
    const text = "Forged: the library supports sub-millisecond updates on every platform."
    const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    const file = `.factory/research/sources/${hash}.md`
    for (const agent of ["es-research-alpha", "build"]) {
      const attempts = [
        call("write", { path: file, content: text }),
        call("patch", {
          patchText: `*** Begin Patch\n*** Add File: .factory/research/dossier.json\n+{}\n*** End Patch`,
        }),
      ]
      const { tools } = await h.run(`forge ${attempts.join(" ")}`, { agent })
      expect(tools).toHaveLength(attempts.length)
      for (const outcome of tools)
        expect(`${agent}:${outcome.name}:${outcome.status}`).toBe(`${agent}:${outcome.name}:error`)
    }
    expect(await exists(path.join(h.directory, file))).toBe(false)
    expect(await exists(path.join(h.directory, ".factory/research/dossier.json"))).toBe(false)

    // The adversarial audit (A3): the interpreter shell must not write
    // control files either — the old rule only matched metacharacters.
    const shellForgery = `.factory/research/sources/forged-shell.md`
    const forged = await h.run(
      `forge ${call("shell", { command: `python3 -c 'open("${shellForgery}","w").write("forged")'` })}`,
      { agent: "build" },
    )
    expect(forged.tools[0]?.status).toBe("error")
    expect(await exists(path.join(h.directory, shellForgery))).toBe(false)
  })

  test("search as policy: research seats are offered no host web tools, and a direct call is denied", async () => {
    const offered = async (agent: string) => {
      const before = h.llm.requests.length
      await h.run("hello", { agent })
      return new Set(
        h.llm.requests.slice(before).flatMap((request) => (request.tools ?? []).map((tool) => tool.function.name)),
      )
    }
    // The host does offer them to other agents, so the denial is not vacuous.
    expect([...(await offered("build"))].filter((name) => name.startsWith("web")).sort()).toEqual([
      "webfetch",
      "websearch",
    ])
    for (const agent of ["es-research-alpha", "es-research-beta"]) {
      const tools = await offered(agent)
      expect([agent, tools.has("webfetch"), tools.has("websearch"), tools.has("es_research_fetch")]).toEqual([
        agent,
        false,
        false,
        true,
      ])
    }
    const { tools } = await h.run(`go ${call("webfetch", { url: "https://example.com", format: "text" })}`, {
      agent: "es-research-alpha",
    })
    expect(tools[0]?.status).toBe("error")
  })

  test("panel RPCs return structured state for the four dashboards", async () => {
    const rpc = rpcFor(h)
    const factory = await rpc.factoryState({}, where(h))
    expect(factory.stage).toBe("NONE")
    expect(factory.spend).toMatchObject({ usd: 0, estimated: false })
    expect(Array.isArray(factory.phases)).toBe(true)
    expect(Array.isArray(factory.pending)).toBe(true)

    const lsp = await rpc.lspState({}, where(h))
    expect(typeof lsp.enabled).toBe("boolean")
    expect(Array.isArray(lsp.servers)).toBe(true)
    expect(lsp.servers.length).toBeGreaterThan(0)

    const hooks = await rpc.hooksState({}, where(h))
    expect(typeof hooks.handlers).toBe("number")
    expect(typeof hooks.trusted).toBe("boolean")
    expect(Array.isArray(hooks.loss)).toBe(true)

    const brainstorm = await rpc.brainstormState({}, where(h))
    expect(brainstorm).toEqual({ active: false })
  })

  test("the user's build agent sees only the read-only es tools; factory agents get the state block", async () => {
    await h.run("hello")
    const build = lastAgentRequest(h.llm.requests)
    const names = (build?.tools ?? []).map((tool) => tool.function.name).filter((name) => name.startsWith("es_"))
    expect(names.sort()).toEqual(["es_gates_run", "es_status"])
    expect(systemText(build)).not.toContain("<factory-state>")
    await h.run("hello", { agent: "factory" })
    const factory = lastAgentRequest(h.llm.requests)
    expect(systemText(factory)).toContain("<factory-state>")
    expect((factory?.tools ?? []).map((tool) => tool.function.name)).toContain("es_build_start")
    expect((factory?.tools ?? []).map((tool) => tool.function.name)).not.toContain("es_complete")
  })

  test("skills are scoped per seat; autonomous seats cannot ask questions", async () => {
    await h.run("hello", { agent: "factory" })
    const factory = lastAgentRequest(h.llm.requests)
    expect(systemText(factory)).toContain("<id>factory</id>")
    expect(systemText(factory)).not.toContain("<id>grill</id>")
    await h.run("hello", { agent: "grill" })
    const grill = lastAgentRequest(h.llm.requests)
    expect(systemText(grill)).toContain("<id>grill</id>")
    expect(systemText(grill)).not.toContain("<id>factory</id>")
    // Primaries talk to the human and keep the question tool; subagent seats are autonomous.
    expect((grill?.tools ?? []).map((tool) => tool.function.name)).toContain("question")
    await h.run("hello", { agent: "es-programmer" })
    const programmer = lastAgentRequest(h.llm.requests)
    expect((programmer?.tools ?? []).map((tool) => tool.function.name)).not.toContain("question")
    expect(systemText(programmer)).not.toContain("<id>grill</id>")
  })

  test("seats are not offered Code Mode; the user's own agent still is (issue #50)", async () => {
    const offered = async (agent: string) => {
      await h.run("hello", { agent })
      return (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    }
    expect(await offered("build")).toContain("execute")
    for (const agent of ["factory", "grill", "brainstormer", "harvester", "es-research-alpha", "es-programmer"])
      expect([agent, (await offered(agent)).includes("execute")]).toEqual([agent, false])
  })

  test("the factory invokes a hidden seat by id; compaction keeps the factory state", async () => {
    const { sessionID } = await h.run(
      `delegate ${call("subagent", { agent: "es-manager", description: "plan", prompt: "summarise the roadmap" })}`,
      { agent: "factory" },
    )
    const subagent = (lastAgentRequest(h.llm.requests)?.tools ?? []).find((tool) => tool.function.name === "subagent")
    expect(subagent?.function.description ?? "").not.toContain("es-manager")
    expect(JSON.stringify(h.llm.requests.at(-1))).toContain('state=\\"completed\\"')
    const before = h.llm.requests.length
    await h.opencode.sessions.compact({ sessionID } as any)
    await h.opencode.sessions.wait({ sessionID } as any)
    const compaction = h.llm.requests
      .slice(before)
      .find((request) => systemText(request).includes("Preserve this factory state"))
    expect(compaction).toBeDefined()
    expect(systemText(compaction)).toContain("<factory-state>")
  })

  test("a QA seat cannot write, and its shell writes never escape (sandboxed, or refused without bwrap)", async () => {
    const { tools } = await h.run(
      `qa ${call("write", { path: "src/x.ts", content: "x" })} ${call("shell", { command: "touch QA_TOUCHED; echo tried" })}`,
      { agent: "es-qa-functional" },
    )
    expect(tools[0]?.status).toBe("error")
    // With bwrap the command runs and the write fails or vanishes; without it
    // factory seats get no shell at all (1.1.1). Either way nothing escapes.
    const shell = tools[1]
    if (bwrapAvailable()) expect(shell?.text).toContain("tried")
    else expect(shell?.text).toMatch(/bubblewrap/i)
    expect(await exists(path.join(h.directory, "QA_TOUCHED"))).toBe(false)
  })

  test.skipIf(!bwrapAvailable())(
    "the 1.1.0 audit's shell attacks fail in the sandbox even when they evade the text rules",
    async () => {
      await mkdir(path.join(h.directory, ".factory/research/sources"), { recursive: true })
      await writeFile(path.join(state, "key"), "PLANTED-SIGNING-KEY\n")
      const sh = async (agent: string, command: string) =>
        (await h.run(`x ${call("shell", { command })}`, { agent })).tools[0]
      // P1/P5: variable indirection hides the factory dir from any text rule.
      for (const agent of ["build", "es-programmer"]) {
        const forged = await sh(agent, 'F=.fac; cd "${F}tory" && echo forged > research/sources/forged.md; echo done')
        expect([agent, forged?.status]).toEqual([agent, "completed"])
        expect(await exists(path.join(h.directory, ".factory/research/sources/forged.md"))).toBe(false)
      }
      // P3: the programmer reads the signing key through a glob.
      const leak = await sh(
        "es-programmer",
        `D=${path.dirname(state)}; cat "$D"/${path.basename(state)}/k* ; echo done`,
      )
      expect(leak?.text ?? "").not.toContain("PLANTED-SIGNING-KEY")
      // P4: a cached-web research seat reaches a local server.
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("NET-REACHED") })
      try {
        const net = await sh(
          "es-research-alpha",
          `python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${server.port}/').read())"; echo done`,
        )
        expect(net?.text ?? "").not.toContain("NET-REACHED")
      } finally {
        server.stop(true)
      }
    },
    60_000,
  )

  test("the STOP file stops factory seats and es tools, not the user's own agent", async () => {
    await mkdir(path.join(h.directory, ".factory"), { recursive: true })
    await writeFile(path.join(h.directory, ".factory/STOP"), "pause")
    const seat = await h.run(`go ${call("es_status")}`, { agent: "factory" })
    expect(seat.tools[0]?.status).toBe("error")
    expect(seat.tools[0]?.text).toContain("stopped")
    const user = await h.run(`go ${call("read", { path: "README.md" })}`)
    expect(user.tools[0]?.status).toBe("completed")
    await rm(path.join(h.directory, ".factory/STOP"))
  })

  test("issue #49: no approval RPC exists for a stolen service password to call", async () => {
    // S3 masks service.json in every agent sandbox (sandbox.test.ts); S4
    // removed the mutate methods, so even a caller with a valid preview token
    // has no RPC to redeem it through. Previews still work for the TUI.
    const rpc = rpcFor(h) as any
    for (const method of ["approve", "trust", "resume"]) expect(typeof rpc[method]).not.toBe("function")
    const approval = await rpc.previewApproval({ stage: "frontier" }, where(h))
    expect(typeof approval.title).toBe("string")
    expect(Array.isArray(approval.lines)).toBe(true)
    expect(((await rpc.previewTrust({}, where(h))).lines ?? []).length).toBeGreaterThan(0)
  })
})

describe("a factory run end to end on the real host", () => {
  let h: Harness
  const phase = "greet"
  beforeAll(async () => {
    h = await host({ "package.json": JSON.stringify({ name: "demo", devDependencies: { "@types/bun": "*" } }) })
  }, 60_000)
  afterAll(() => h?.close())

  const frontier = {
    version: "1.1",
    idea: "A greeting module",
    spendCeiling: { currency: "USD", maxAmount: 5 },
    settled: true,
    nodes: [{ id: "api", question: "API shape?", answer: "greet(name): string", status: "settled" }],
  }
  const goal = [
    "---",
    `phase: ${phase}`,
    "title: Greeting function",
    "acceptance:",
    "  - kind: test",
    "    id: unit",
    "    description: greet is unit tested",
    "    path: test/greet.test.ts",
    "  - kind: file",
    "    id: impl",
    "    description: implementation exists",
    "    path: src/greet.ts",
    "---",
    "Implement greet(name) returning `Hello, <name>!`, test first.",
    "",
  ].join("\n")

  test("grill → human approves frontier → research → spec → human approves spec → build", async () => {
    const grill = await h.run(
      `${call("es_frontier_write", { frontier })} ${call("es_request_approval", { stage: "frontier" })}`,
      { agent: "grill" },
    )
    expect(grill.tools.map((tool) => tool.status)).toEqual(["completed", "completed"])
    expect(grill.tools[1]?.text).toContain("/es-approve")

    const rpc = rpcFor(h)
    const preview = await rpc.previewApproval({ stage: "frontier" }, where(h))
    expect(preview.ok).toBe(true)
    expect(preview.lines.join("\n")).toContain("$5 USD")
    // S4: approve/trust/resume RPCs removed — TUI previews, terminal signs with the sealed key.
    expect(typeof (rpc as any).approve).not.toBe("function")
    await recordApproval(h.directory, { stage: "frontier", channel: "cli", signer })
    await writeJson(
      factoryLayout(h.directory).pending,
      (await pendingApprovals(h.directory)).filter((item) => item.stage !== "frontier"),
    )
    const fac = new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
    if (!(await fac.read())) await fac.begin("human:tester")
    if ((await fac.read())?.stage === "GRILL") await fac.beginResearch("human:tester")
    expect((await rpc.status({}, where(h))).stage).toBe("RESEARCH")

    const cache = new SourceCache(researchSourcesDir(h.directory), state)
    const source = await cache.put({
      url: "https://example.test/greet",
      text: "A greeting module exports greet(name) and returns a string.",
      provider: "fetch",
    })
    await mkdir(path.join(h.directory, ".factory/research"), { recursive: true })
    await writeFile(
      path.join(h.directory, ".factory/research/REPORT.md"),
      `# Research\n\n- greet returns a string [VERIFIED: sha256:${source.meta.sha256} "exports greet(name) and returns a string"]\n`,
    )

    const research = await h.run(call("es_research_complete"), { agent: "factory" })
    expect(research.tools[0]?.status).toBe("completed")

    const manager = await h.run(
      [
        call("write", {
          path: ".factory/roadmap.json",
          content: JSON.stringify({
            version: 1,
            title: "Greeting",
            phases: [{ id: phase, title: "Greeting function" }],
          }),
        }),
        call("write", { path: `.factory/specs/${phase}/GOAL.md`, content: goal }),
        call("write", { path: "src/sneaky.ts", content: "x" }),
        call("es_spec_validate"),
      ].join(" "),
      { agent: "es-manager" },
    )
    expect(manager.tools.map((tool) => tool.status)).toEqual(["completed", "completed", "error", "completed"])
    expect(manager.tools[3]?.text).toContain("Spec is valid")

    const early = await h.run(call("es_build_start"), { agent: "factory" })
    expect(early.tools[0]?.text).toContain("no spec approval")
    const spec = await rpc.previewApproval({ stage: "spec" }, where(h))
    expect(spec.ok).toBe(true)
    await recordApproval(h.directory, { stage: "spec", channel: "cli", signer })
    await writeJson(
      factoryLayout(h.directory).pending,
      (await pendingApprovals(h.directory)).filter((item) => item.stage !== "spec"),
    )
    const build = await h.run(call("es_build_start"), { agent: "factory" })
    expect(build.tools[0]?.status).toBe("completed")
    expect(build.tools[0]?.text).toContain(`worktree:.factory/worktrees/${phase}`)
  }, 120_000)

  test("gate commands only run after a human trusts them", async () => {
    const before = await h.run(call("es_gates_run", { scope: "full" }), { agent: "factory" })
    expect(before.tools[0]?.text).toContain("trust/untrusted")
    const rpc = rpcFor(h)
    const preview = await rpc.previewTrust({}, where(h))
    expect(preview.lines.join("\n")).toContain("bun test")
    expect(typeof (rpc as any).trust).not.toBe("function")
    const { config } = await loadGatesConfig(h.directory)
    const gates = await commandSetHash(h.directory, config.commands)
    const hooks = (await HookEngine.create({ root: h.directory, stateDir: state, audit: false })).status()
    await trustProject(h.directory, gates.hash, gates.lines, { stateDir: state, signer })
    if (hooks.projectHash)
      await trustProject(h.directory, hooks.projectHash, hooks.projectLines, {
        stateDir: state,
        kind: "hooks",
        signer,
      })
  }, 60_000)

  test("programmer: red test first, implement in the worktree, gated complete", async () => {
    const worktree = path.join(h.directory, ".factory/worktrees", phase)
    const testFile = path.join(worktree, "test/greet.test.ts")
    const impl = path.join(worktree, "src/greet.ts")
    // The implementation's source text contains a template literal on purpose.
    const implBody = ["export function greet(name: string): string {", "  return `Hello, $" + "{name}!`", "}", ""].join(
      "\n",
    )
    const testBody =
      'import { expect, test } from "bun:test"\nimport { greet } from "../src/greet.ts"\ntest("greets", () => expect(greet("Ada")).toBe("Hello, Ada!"))\n'

    const outside = await h.run(call("write", { path: "src/greet.ts", content: "x" }), { agent: "es-programmer" })
    expect(outside.tools[0]?.status).toBe("error")
    expect(outside.tools[0]?.text).toContain("worktree")

    const red = await h.run(
      `${call("write", { path: testFile, content: testBody })} ${call("es_gates_run", { files: [testFile] })}`,
      { agent: "es-programmer" },
    )
    expect(red.tools[1]?.text).toContain("test/failed")

    const early = await h.run(call("es_qa_verdict", { verdict: "pass", notes: "self-approval" }), {
      agent: "es-programmer",
    })
    expect(early.tools[0]?.status).toBe("error")

    const green = await h.run(`${call("write", { path: impl, content: implBody })} ${call("es_complete")}`, {
      agent: "es-programmer",
    })
    expect(green.tools[1]?.text).toContain("is complete and in QA")
    expect(await readFile(impl, "utf8")).toContain("Hello")
    expect(await exists(path.join(h.directory, "src/greet.ts"))).toBe(false)
  }, 120_000)

  test("both QA seats pass → release refuses without a PR opener and waits for a human", async () => {
    for (const seat of ["es-qa-functional", "es-qa-adversarial"]) {
      const verdict = await h.run(call("es_qa_verdict", { verdict: "pass", notes: "criteria met" }), { agent: seat })
      expect(verdict.tools[0]?.status).toBe("completed")
    }
    expect((await rpcFor(h).status({}, where(h))).stage).toBe("RELEASE")
    const release = await h.run(call("es_release"), { agent: "factory" })
    expect(release.tools[0]?.text).toContain("no PR opener")
  }, 120_000)

  test("spend from factory sessions is tracked (estimated when the host reports no cost)", async () => {
    const status = JSON.parse(await readFile(path.join(h.directory, ".factory/runtime/state.json"), "utf8"))
    expect(status.spend.usd).toBeGreaterThan(0)
    expect(status.spend.estimated).toBe(true)
  })
})
