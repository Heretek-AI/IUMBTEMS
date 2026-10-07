// Epistemic Swarm for OpenCode v2 (server plugin). Additive: registers our
// agents, tools, skills, commands, hooks and RPC through runtime transforms;
// writes no config files and never touches built-in agents or defaults.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import {
  factoryLayout,
  factorySummary,
  formatReport,
  git,
  loadSkills,
  readJson,
  researchSourcesDir,
  runGates,
} from "@heretek-ai/es-core"
import { Plugin } from "@opencode/plugin"
import { compileAgents } from "./agents.ts"
import { createFactoryContinuation } from "./continue.ts"
import { createHookBridge } from "./hooks.ts"
import { createPolicyHooks } from "./policy.ts"
import { createWebfetchCache, registerWebsearch } from "./research.ts"
import { createRpcHandlers } from "./rpc.ts"
import { EsRpc } from "./rpc-def.ts"
import { createRuntime, parseOptions } from "./runtime.ts"
import { createSessionHooks, createSpendTracker } from "./session.ts"
import { registerTools } from "./tools.ts"

export const PLUGIN_ID = "epistemic-swarm"

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = parseOptions(ctx.options as Record<string, unknown>)
    const runtime = createRuntime(ctx.location.directory, options)

    // Agents: canonical registry → v2 agents with wildcard-deny scoping.
    const servers = await ctx.mcp.list().then(
      (page: any) => ((page?.data ?? page ?? []) as Array<{ name: string }>).map((server) => server.name),
      () => [] as string[],
    )
    const agents = await compileAgents(options, servers)
    await ctx.agent.transform((editor) => {
      for (const compiled of agents)
        editor.update(compiled.spec.id, (agent) => {
          agent.mode = compiled.spec.mode
          agent.hidden = compiled.spec.hidden
          agent.description = compiled.spec.description
          agent.system = compiled.system
          agent.permissions = [...agent.permissions, ...compiled.permissions] as any
          if (compiled.model) agent.model = compiled.model as any
        })
    })

    // Skills: one shared SKILL.md tree, registered at runtime (no files written).
    const skills = await loadSkills()
    await ctx.skill.transform((editor) => {
      for (const skill of skills)
        editor.add({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          path: skill.path,
          content: skill.content,
        } as any)
    })

    await ctx.tool.transform((editor) => registerTools(editor, runtime))
    await ctx.websearch.transform((editor) => registerWebsearch(editor as any, runtime))

    // Our policy runs first, so its denials win over any user hook.
    const policy = createPolicyHooks(runtime)
    const bridge = await createHookBridge(ctx as any, runtime, () => servers)
    const sessionAgents = new Map<string, string | undefined>()
    const agentOf = async (sessionID: string) => {
      if (!sessionAgents.has(sessionID))
        sessionAgents.set(
          sessionID,
          ((await ctx.session.get({ sessionID } as any).catch(() => undefined)) as any)?.agent,
        )
      return sessionAgents.get(sessionID)
    }
    await ctx.tool.hook("execute.before", policy.before as any)
    await ctx.tool.hook("execute.before", bridge.before as any)
    await ctx.tool.hook("execute.after", policy.after as any)
    await ctx.tool.hook("execute.after", createWebfetchCache(runtime) as any)
    await ctx.tool.hook("execute.after", bridge.after as any)
    await ctx.permission.hook("evaluate", policy.evaluate as any)
    await ctx.permission.hook("evaluate", bridge.evaluate as any)
    await ctx.shell.hook("create.before", policy.shellEnv)
    await ctx.shell.hook("create.before", bridge.shell as any)
    await ctx.session.hook("prompt", (async (event: any) =>
      bridge.prompt(event, await agentOf(event.sessionID))) as any)

    const session = createSessionHooks(runtime)
    await ctx.session.hook("context", session.context as any)
    await ctx.session.hook("context", bridge.context as any)
    await ctx.session.hook("compaction", session.compaction as any)
    const continuation = createFactoryContinuation(ctx as any, runtime)

    // Human-only channel for the TUI (approvals, trust, resume).
    let registration: { events: { emit: (...args: any[]) => Promise<void> } } | undefined
    const notify = async () => {
      const state = await runtime.factory.read()
      await registration?.events
        .emit("changed", { stage: state?.stage ?? "NONE", summary: factorySummary(state) })
        .catch(() => undefined)
    }
    registration = await ctx.rpc.register(EsRpc, createRpcHandlers(runtime, notify, bridge.engine) as any)

    await ctx.command.transform((editor) => {
      editor.add({
        name: "grill",
        description: "Grill an idea until the design and spend ceiling are settled (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchAgent({ sessionID, agent: "grill" } as any)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: prompt.text?.trim() ? `Grill me on: ${prompt.text}` : "Start grilling me on my idea.",
            delivery,
          } as any)
        },
      })
      editor.add({
        name: "brainstorm",
        description: "Fan out divergent lenses on an idea and return a diversified shortlist (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchAgent({ sessionID, agent: "brainstormer" } as any)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: prompt.text?.trim()
              ? `Brainstorm: ${prompt.text}`
              : "Ask me for the idea to brainstorm (one sentence), then run the lens fan-out.",
            delivery,
          } as any)
        },
      })
      editor.add({
        name: "harvest",
        description: "Tear down competitor projects: licences, feature matrix, clean-room specs (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchAgent({ sessionID, agent: "harvester" } as any)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: prompt.text?.trim()
              ? `Darkharvest: ${prompt.text}`
              : "Ask me for the teardown objective and the candidate projects, then run the harvest.",
            delivery,
          } as any)
        },
      })
      editor.add({
        name: "design",
        description: "Interview me into a design system: tokens, contrast gates, style guide (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchAgent({ sessionID, agent: "designer" } as any)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: prompt.text?.trim()
              ? `Run the design interview. Product: ${prompt.text}`
              : "Ask me for the product name and start the design interview, one question at a time.",
            delivery,
          } as any)
        },
      })
      editor.add({
        name: "factory",
        description: "Drive the build factory from its current stage (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchAgent({ sessionID, agent: "factory" } as any)
          const state = await runtime.factory.read()
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${factorySummary(state)}\nContinue the factory run from its current stage.${prompt.text?.trim() ? `\nHuman note: ${prompt.text}` : ""}`,
            delivery,
          } as any)
        },
      })
      editor.add({
        name: "gates",
        description: "Run the mechanical gates on changed files (Epistemic Swarm)",
        execute: async ({ sessionID }) => {
          const changed = (await git(runtime.root, ["status", "--porcelain=v1", "-uall"], { allowFail: true })).stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(3).split(" -> ").at(-1)!)
          const report = await runGates({
            root: runtime.root,
            scope: changed.length ? "touched" : "full",
            touched: changed,
            stateDir: runtime.stateDir,
          })
          await ctx.session.synthetic({ sessionID, text: formatReport(report) } as any)
        },
      })
      editor.add({
        name: "lsp",
        description: "Language servers: configured, available and running (Epistemic Swarm)",
        execute: async ({ sessionID }) => {
          const status = await runtime.lsp.status()
          const settings = await runtime.lsp.settings()
          const lines = [status.enabled ? "LSP is on." : "LSP is disabled (lsp: false)."]
          for (const server of settings.servers) {
            const command = await runtime.lsp.command(server, runtime.root)
            const running = status.running.filter((item) => item.id === server.id)
            lines.push(
              `${server.id} [${server.extensions.join(" ")}]: ${Array.isArray(command) ? `available (${command.join(" ")})` : command.unavailable}${running.length ? ` · running for ${running.length} root(s)` : ""}`,
            )
          }
          lines.push(...status.diagnostics.map((item) => `! ${item}`))
          await ctx.session.synthetic({ sessionID, text: lines.join("\n") } as any)
        },
      })
      editor.add({
        name: "hooks",
        description: "Show the hook bridge: sources, handlers, trust and diagnostics (Epistemic Swarm)",
        execute: async ({ sessionID }) => {
          await bridge.engine.refresh()
          const status = bridge.engine.status()
          const trust =
            status.projectHandlers === 0
              ? "nothing to trust"
              : status.trusted
                ? "trusted"
                : "NOT trusted: run /es-trust or `es trust`"
          const lines = [
            `Hook bridge: ${status.handlers} handler(s), ${status.projectHandlers} from the project (${trust}).`,
            ...status.projectLines,
            ...status.diagnostics.map((item) => `! ${item}`),
            ...bridge.engine.recent.slice(-10).map((item) => `recent error: ${item}`),
            "Stop hooks are emulated after the turn ends (advisory for plain chat).",
          ]
          await ctx.session.synthetic({ sessionID, text: lines.join("\n") } as any)
        },
      })
      editor.add({
        name: "status",
        description: "Show the factory state (Epistemic Swarm)",
        execute: async ({ sessionID }) => {
          await ctx.session.synthetic({ sessionID, text: factorySummary(await runtime.factory.read()) } as any)
        },
      })
      editor.add({
        name: "research",
        description: "Research stage: report, audit coverage and cached sources (Epistemic Swarm)",
        execute: async ({ sessionID }) => {
          const layout = factoryLayout(runtime.root)
          const report = await readFile(layout.researchReport, "utf8").catch(() => undefined)
          const coverage = await readJson<{
            claims?: number
            grounded?: number
            untagged?: number
            ungrounded?: number
            malformed?: number
            sources?: number
            passed?: boolean
          }>(path.join(layout.research, "coverage.json")).catch(() => undefined)
          const sources = (await readdir(researchSourcesDir(runtime.root)).catch(() => [])).filter((file) =>
            file.endsWith(".md"),
          )
          const lines = [
            report === undefined
              ? "No research report yet (.factory/research/REPORT.md)."
              : `Report: ${report.length} characters in .factory/research/REPORT.md.`,
            coverage
              ? `Audit: ${coverage.grounded ?? 0}/${coverage.claims ?? 0} claims grounded (untagged ${coverage.untagged ?? 0}, ungrounded ${coverage.ungrounded ?? 0}, malformed ${coverage.malformed ?? 0}); cited sources ${coverage.sources ?? 0}; passed ${coverage.passed ? "yes" : "no"}.`
              : "No coverage.json yet (es_research_complete writes it).",
            `Cached sources: ${sources.length}.`,
          ]
          await ctx.session.synthetic({ sessionID, text: lines.join("\n") } as any)
        },
      })
    })

    // Spend: per-step host cost for factory-agent sessions (estimated from tokens when cost is 0).
    const track = createSpendTracker(runtime, agentOf)
    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal }) as AsyncIterable<any>) {
          await track(event).catch(() => undefined)
          await bridge.onEvent(event, agentOf).catch(() => undefined)
          await continuation(event, agentOf).catch(() => undefined)
        }
      } catch {
        // stream closed on unload
      }
    })()
    return async () => {
      abort.abort()
      await runtime.lsp.stopAll()
    }
  },
})
