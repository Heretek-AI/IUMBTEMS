// Permission and tool-scoping probe suite (#100, replaces #76): a permission
// matrix GENERATED from the canonical registry (a new seat is covered
// automatically), plus real-host bypass probes, one per restriction class.
// Rule evaluation uses the vendored host semantics (testkit/permission.ts:
// OpenCode v2 Permission.evaluate + Wildcard.match, MIT), so a matrix verdict
// means what the host enforces.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AGENTS,
  type AgentSpec,
  ALL_ES_TOOLS,
  approveStage,
  bwrapAvailable,
  Factory,
  factoryLayout,
  gateRunner,
  type HumanSigner,
  researchSourcesDir,
  SourceCache,
  sealHumanKey,
  stringifyFrontmatter,
  unlockHumanKey,
} from "@heretek-ai/es-core"
import { boot, directiveScript, evaluatePermission, type Harness, matchWildcard } from "@heretek-ai/es-testkit"
import { createMcpServer } from "../../cli/src/mcp.ts"
import { HOST_WEB_TOOLS, permissionRules } from "../src/agents.ts"
import { createRuntime, parseOptions } from "../src/runtime.ts"
import { registerTools } from "../src/tools.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

/** MCP servers on a representative host: no seat lists any of them. */
const SERVERS = ["probe", "memory"] as const

const effectOf = (spec: AgentSpec, action: string, resource = "*") =>
  evaluatePermission(action, resource, permissionRules(spec, SERVERS)).effect

describe("vendored host rule semantics (OpenCode v2, MIT)", () => {
  test("Wildcard.match: * spans separators, ? is one character", () => {
    expect(matchWildcard("es_status", "es_*")).toBe(true)
    expect(matchWildcard("status", "es_*")).toBe(false)
    expect(matchWildcard("probe_alpha", "probe_*")).toBe(true)
    expect(matchWildcard("/tmp/x", "/tmp/*")).toBe(true)
    expect(matchWildcard("abc", "a?c")).toBe(true)
    expect(matchWildcard("ac", "a?c")).toBe(false)
  })

  test("Permission.evaluate: the last matching rule wins, silence asks", () => {
    const rules = [
      { action: "es_*", resource: "*", effect: "deny" as const },
      { action: "es_status", resource: "*", effect: "allow" as const },
    ]
    expect(evaluatePermission("es_status", "*", rules).effect).toBe("allow")
    expect(evaluatePermission("es_gates_run", "*", rules).effect).toBe("deny")
    expect(evaluatePermission("question", "*", rules).effect).toBe("ask")
  })
})

describe("permission matrix generated from the registry", () => {
  for (const spec of AGENTS) {
    describe(spec.id, () => {
      test("es_* tools: allowed exactly when the registry grants them", () => {
        for (const tool of [...ALL_ES_TOOLS, "es_imaginary"])
          expect([tool, effectOf(spec, tool)]).toEqual([tool, spec.tools.includes(tool) ? "allow" : "deny"])
      })

      test("host web tools are denied if and only if web is cached", () => {
        for (const tool of HOST_WEB_TOOLS)
          expect([tool, effectOf(spec, tool)]).toEqual([tool, spec.web === "cached" ? "deny" : "ask"])
      })

      test("edit is denied if and only if the seat writes nothing", () => {
        expect(effectOf(spec, "edit")).toBe(spec.writes.length === 0 ? "deny" : "ask")
      })

      test("question and external_directory follow the subagent line", () => {
        if (spec.mode === "subagent") {
          expect(effectOf(spec, "question")).toBe("deny")
          expect(evaluatePermission("external_directory", "/tmp/x", permissionRules(spec, SERVERS)).effect).toBe(
            "allow",
          )
          expect(evaluatePermission("external_directory", "/etc/x", permissionRules(spec, SERVERS)).effect).toBe("deny")
        } else {
          expect(effectOf(spec, "question")).toBe("ask")
        }
      })

      test("subagent launches are allowed exactly for listed spawns", () => {
        for (const target of [...spec.spawns, "es-ghost-xyz"])
          expect([target, evaluatePermission("subagent", target, permissionRules(spec, SERVERS)).effect]).toEqual([
            target,
            spec.spawns.includes(target) ? "allow" : "deny",
          ])
      })

      test("skills and MCP servers are allowed exactly when listed", () => {
        for (const skill of [...spec.skills, "ghost-skill"])
          expect([skill, evaluatePermission("skill", skill, permissionRules(spec, SERVERS)).effect]).toEqual([
            skill,
            spec.skills.includes(skill) ? "allow" : "deny",
          ])
        for (const server of SERVERS)
          for (const tool of [`${server}_alpha`, `${server.replace(/[^\w-]/g, "_")}_alpha`])
            expect([tool, effectOf(spec, tool)]).toEqual([tool, spec.mcp.includes(server) ? "ask" : "deny"])
      })

      test("Code Mode execute is always denied; LSP follows its mode", () => {
        expect(effectOf(spec, "execute")).toBe("deny")
        expect(effectOf(spec, "lsp")).toBe(spec.lsp === "none" ? "deny" : "ask")
        expect(effectOf(spec, "lsp_rename")).toBe(spec.lsp === "full" ? "ask" : "deny")
      })
    })
  }
})

describe("bypass probes on the real host (fake model)", () => {
  let h: Harness
  let state: string

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-scoping-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# scoping\n" },
    })
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("a cached-web seat cannot call host webfetch", async () => {
    const { tools } = await h.run(`fetch ${call("webfetch", { url: "https://example.com" })}`, {
      agent: "es-research-alpha",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["webfetch:error"])
    expect(tools[0]?.text).toContain("only through es_research_search and es_research_fetch")
  })

  test("a subagent seat cannot ask questions", async () => {
    const { tools } = await h.run(
      `ask ${call("question", { questions: [{ question: "Proceed?", header: "P", options: [{ label: "Yes", description: "go" }] }] })}`,
      { agent: "es-qa-functional" },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["question:error"])
  })

  test("a read-only seat cannot edit", async () => {
    const { tools } = await h.run(`edit ${call("edit", { path: "README.md", content: "hijacked" })}`, {
      agent: "es-qa-functional",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["edit:error"])
    expect(tools[0]?.text).toContain("is read-only")
  })

  test("the programmer cannot write outside its worktree", async () => {
    const { tools } = await h.run(`edit ${call("edit", { path: "PROBE-NOTES.md", content: "x" })}`, {
      agent: "es-programmer",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["edit:error"])
    expect(tools[0]?.text).toContain("no active phase worktree")
  })

  test("a seat shell cannot read the state dir", async () => {
    const { tools } = await h.run(`read ${call("shell", { command: `cat ${state}/engine.key` })}`, {
      agent: "es-qa-functional",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:error"])
    expect(tools[0]?.text).toContain("private state dir")
  })

  test("the server password never reaches a seat shell", async () => {
    // End to end: the secret sits in the host's own environment, and even a
    // seat's sandboxed shell must not see it (hook strips it, bwrap unsets it).
    const saved = process.env.OPENCODE_SERVER_PASSWORD
    process.env.OPENCODE_SERVER_PASSWORD = "probe-secret"
    try {
      const { tools } = await h.run(`leak ${call("shell", { command: "echo pw=$OPENCODE_SERVER_PASSWORD" })}`, {
        agent: "es-programmer",
      })
      if (!bwrapAvailable()) {
        // Without the sandbox a seat shell never runs at all: still no leak.
        expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:error"])
        expect(tools[0]?.text).toContain("bubblewrap")
        expect(tools[0]?.text).not.toContain("probe-secret")
        return
      }
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
      expect(tools[0]?.text).toContain("pw=")
      expect(tools[0]?.text).not.toContain("probe-secret")
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = saved
    }
  })

  test("the shellEnv hook strips password variables and keeps the rest", async () => {
    const { createPolicyHooks } = await import("../src/policy.ts")
    const hooks = createPolicyHooks({ root: h.directory } as any)
    const env: Record<string, string | undefined> = {
      OPENCODE_SERVER_PASSWORD: "s",
      OPENCODE_PASSWORD: "s",
      PATH: "/bin",
    }
    hooks.shellEnv({ env })
    expect(env).toEqual({ PATH: "/bin" })
  })

  test("an offline seat shell has no network", async () => {
    if (!bwrapAvailable()) {
      const { tools } = await h.run(`net ${call("shell", { command: "cat /proc/net/dev" })}`, {
        agent: "es-research-alpha",
      })
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:error"])
      expect(tools[0]?.text).toContain("bubblewrap")
      return
    }
    // /proc/net/dev is net-namespace aware (only lo: under --unshare-net);
    // /sys/class/net leaks host interfaces through the --ro-bind / / (#100).
    const { tools } = await h.run(`net ${call("shell", { command: "cat /proc/net/dev" })}`, {
      agent: "es-research-alpha",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
    const ifaces = tools[0]?.text
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => line.split(":")[0]?.trim() ?? "")
      .filter(Boolean)
    expect(ifaces).toEqual(["lo"])
  })

  test("a seat cannot launch a seat outside its spawns", async () => {
    const { tools } = await h.run(
      `delegate ${call("subagent", { agent: "es-programmer", description: "x", prompt: "escape" })}`,
      { agent: "es-qa-functional" },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:error"])
  })
})

describe("programmer worktree scoping with an active phase worktree (#100)", () => {
  let work: Harness
  let workState: string
  let signer: HumanSigner

  const write = async (root: string, file: string, text: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), text)
  }
  const workFactory = () =>
    new Factory(work.directory, { gates: gateRunner({ stateDir: workState }), stateDir: workState })

  beforeAll(async () => {
    workState = await mkdtemp(path.join(tmpdir(), "es-scoping-work-"))
    await sealHumanKey("test-passphrase-1234", workState)
    signer = await unlockHumanKey("test-passphrase-1234", workState)
    work = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: workState, pr: "off" } }],
      files: { "README.md": "# scoping worktree\n" },
    })
    // Walk the pipeline to BUILD so a phase worktree exists.
    const factory = workFactory()
    await factory.provisionRun("tester", 10)
    await factory.writeFrontier("grill", {
      version: "1.1",
      idea: "a session handoff feature",
      spendCeiling: { currency: "USD", maxAmount: 10 },
      round: 1,
      settled: true,
      nodes: [{ id: "scope", question: "Which harness first?", status: "settled", answer: "opencode", round: 1 }],
    })
    await approveStage(work.directory, {
      stage: "frontier",
      channel: "cli",
      approvedBy: "tester",
      signer,
      stateDir: workState,
    })
    const cache = new SourceCache(researchSourcesDir(work.directory), workState)
    const source = await cache.put({
      url: "https://example.test/handoff",
      text: "Session handoff writes a file the next agent reads.",
      provider: "fetch",
    })
    const layout = factoryLayout(work.directory)
    await write(
      work.directory,
      path.relative(work.directory, layout.researchReport),
      `- Handoff is file-based [VERIFIED: sha256:${source.meta.sha256} "file the next agent reads"]\n`,
    )
    await factory.completeResearch("factory")
    await write(
      work.directory,
      ".factory/roadmap.json",
      JSON.stringify({ version: 1, title: "Handoff", phases: [{ id: "alpha", title: "Phase alpha" }] }, null, 2),
    )
    await write(
      work.directory,
      ".factory/specs/alpha/GOAL.md",
      stringifyFrontmatter(
        {
          phase: "alpha",
          title: "Phase alpha",
          acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: "src/alpha.ts" }],
        },
        "Implement alpha as a vertical slice.\n",
      ),
    )
    await approveStage(work.directory, {
      stage: "spec",
      channel: "cli",
      approvedBy: "tester",
      signer,
      stateDir: workState,
    })
    const started = await work.run(call("es_build_start", {}), { agent: "factory" })
    expect(started.tools[0]?.status).toBe("completed")
    expect((await workFactory().read())?.stage).toBe("BUILD")
  }, 180_000)
  afterAll(async () => {
    await work?.close()
    await rm(workState, { recursive: true, force: true })
  })

  test("the programmer cannot write outside its worktree when one is active", async () => {
    // `write` (not `edit`) takes raw content, so a removed guard lets the
    // call through instead of failing on arguments.
    const { tools } = await work.run(`write ${call("write", { path: "PROBE-OUTSIDE.md", content: "x" })}`, {
      agent: "es-programmer",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["write:error"])
    expect(tools[0]?.text).toContain("may only write inside its phase worktree")
  })
})

describe("MCP probe (#99): a seat reaches no out-of-spec tool through es mcp", () => {
  let root: string
  let state: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "es-scoping-mcp-"))
    state = await mkdtemp(path.join(tmpdir(), "es-scoping-mcp-state-"))
  })
  afterAll(() => Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]))

  test("a QA-pinned server refuses the programmer-only tool; the piped agent is ignored", async () => {
    const server = createMcpServer({ root, stateDir: state, env: { ES_MCP_AGENT: "es-qa-functional" } })
    const denied = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "complete", arguments: { agent: "es-programmer" } },
    })
    expect(denied?.result.isError).toBe(true)
    expect(denied?.result.content[0].text).toContain("called by es-qa-functional")
  })
})

describe("item 1 (#101): registerTools registers every registry tool exactly once", () => {
  test("the registered es_* names equal ALL_ES_TOOLS with no duplicates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-scoping-reg-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-scoping-reg-state-"))
    try {
      const runtime = await createRuntime(root, parseOptions({ stateDir: state }))
      const names: string[] = []
      registerTools({ add: (tool: any) => void names.push(tool.name) }, runtime)
      await runtime.lsp.stopAll().catch(() => undefined)
      const esNames = names.filter((name) => name.startsWith("es_"))
      expect([...new Set(esNames)].sort()).toEqual([...ALL_ES_TOOLS].sort())
      expect(esNames.length).toBe(new Set(esNames).size)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
