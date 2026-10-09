// Epistemic Swarm for OpenCode v2 (server plugin). Additive: registers our
// agents, tools, skills, commands, hooks and RPC through runtime transforms;
// writes no config files and never touches built-in agents or defaults.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import {
  describeTarget,
  ensureEngineKey,
  factoryLayout,
  formatReport,
  git,
  livenessLines,
  loadSkills,
  parseAuditTarget,
  readJson,
  readLiveness,
  researchSourcesDir,
  runGates,
} from "@heretek-ai/es-core"
import { Plugin } from "@opencode/plugin"
import { compileAgents, modelProblems } from "./agents.ts"
import { createFactoryContinuation } from "./continue.ts"
import { createHookBridge } from "./hooks.ts"
import { createPolicyHooks } from "./policy.ts"
import { createWebCache, PendingSearches, registerWebsearch } from "./research.ts"
import { createRpcHandlers } from "./rpc.ts"
import { EsRpc } from "./rpc-def.ts"
import { createRuntime, parseOptions } from "./runtime.ts"
import { createSeatTracker } from "./seats.ts"
import { createSessionHooks, createSpendTracker } from "./session.ts"
import { registerTools } from "./tools.ts"

export const PLUGIN_ID = "epistemic-swarm"

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = parseOptions(ctx.options as Record<string, unknown>)
    const runtime = await createRuntime(ctx.location.directory, options)
    // The engine key seals cached sources (#52); create it at setup so the
    // masked state dir holds the key before any seat runs.
    await ensureEngineKey(runtime.stateDir)

    // Agents: canonical registry → v2 agents with wildcard-deny scoping.
    const servers = await ctx.mcp.list().then(
      (page: any) => ((page?.data ?? page ?? []) as Array<{ name: string }>).map((server) => server.name),
      () => [] as string[],
    )
    const agents = await compileAgents(runtime.options, servers)
    // Fail-closed models (#96): every configured ref is checked against the
    // host model list here, once. A missing model refuses every tool call by
    // that seat (the policy before-hook) and shows in es_status; healthy
    // seats are unaffected.
    await ctx.model.transform((editor) => {
      for (const problem of modelProblems(
        runtime.options,
        agents.map((agent) => agent.spec),
        (providerID, modelID) => editor.get(providerID, modelID) !== undefined,
      ))
        runtime.modelProblems.set(problem.agent, problem)
    })
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
    // Search results wait here until the tool hook, which knows the agent, decides whether to cache them.
    const searches = new PendingSearches()
    await ctx.websearch.transform((editor) => registerWebsearch(editor as any, runtime, searches))

    // `changed` reaches the TUI (dashboard refetch, stage toast, footer). Bursts
    // (seat activity, tool runs) are coalesced to at most one emit a second.
    let emitChanged: (notice?: string) => Promise<void> = async () => {}
    let lastEmit = 0
    let queued: ReturnType<typeof setTimeout> | undefined
    const notifySoon = () => {
      if (queued) return
      queued = setTimeout(
        () => {
          queued = undefined
          lastEmit = Date.now()
          void emitChanged()
        },
        Math.max(0, 1000 - (Date.now() - lastEmit)),
      )
    }
    // Seat liveness (#60): fed by host events and the policy hook; read by the guard and the continuation.
    const seats = createSeatTracker(runtime, { onChange: notifySoon })
    // Our policy runs first, so its denials win over any user hook.
    const policy = createPolicyHooks(runtime, seats)
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
    // Last: the final (possibly hook-rewritten) shell command is re-checked and sandboxed.
    await ctx.tool.hook("execute.before", policy.sandbox as any)
    await ctx.tool.hook("execute.after", policy.after as any)
    await ctx.tool.hook("execute.after", createWebCache(runtime, searches) as any)
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
    const continuation = createFactoryContinuation(ctx as any, runtime, {
      seats,
      onPause: (notice) => void emitChanged(notice),
    })

    // Human-only channel for the TUI (approvals, trust, resume).
    let registration: { events: { emit: (...args: any[]) => Promise<void> } } | undefined
    // Fire-and-forget from event handlers: a state that cannot be read (halted
    // mid-write, forged seal) must not surface as an unhandled rejection.
    emitChanged = async (notice) => {
      try {
        const state = await runtime.factory.read()
        await registration?.events.emit("changed", {
          stage: state?.stage ?? "NONE",
          summary: await runtime.factory.summary(state),
          ...(notice ? { notice } : {}),
        })
      } catch {
        // The next change or the panels' poll catches up.
      }
    }
    registration = await ctx.rpc.register(
      EsRpc,
      createRpcHandlers(runtime, () => emitChanged(), bridge.engine, { paused: () => continuation.paused() }) as any,
    )
    // Every es_* tool may move the factory: let the TUI know (#62).
    await ctx.tool.hook("execute.after", (async (event: { tool: string }) => {
      if (event.tool.startsWith("es_")) notifySoon()
    }) as any)

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
        name: "scout",
        description: "Find and vet open-source candidates for a feature: licenses, maintenance, CVEs (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchAgent({ sessionID, agent: "scout" } as any)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: prompt.text?.trim()
              ? `Scout: ${prompt.text}`
              : "Ask me for the feature to scout and our license posture, then plan the candidates.",
            delivery,
          } as any)
        },
      })
      editor.add({
        name: "research",
        description: "Adversarial deep research to a grounded report: thesis, antithesis, synthesis (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const say = async (text: string) => {
            await ctx.session.synthetic({ sessionID, text } as any)
          }
          const text = prompt.text?.trim() ?? ""
          const query = text.replace(/^deep\s+/i, "").trim()
          const ceiling = /--max-usd\s+([\d.]+)/.exec(text)?.[1]
          if (!/^deep(\s|$)/i.test(text) || !query.replace(/--max-usd\s+[\d.]+/, "").trim()) {
            return say("Usage: /research deep <question> --max-usd N")
          }
          if (ceiling === undefined || !(Number(ceiling) > 0)) {
            return say(
              "Deep research needs a spend ceiling you set: /research deep <question> --max-usd N. Seats halt when the spend reaches it.",
            )
          }
          const existing = await runtime.factory.read().catch(() => undefined)
          if (existing && existing.mode !== "research") {
            return say(
              "This project holds a build run. Start deep research in a directory without one (`es research deep <question> --output <dir> --max-usd N` at a terminal).",
            )
          }
          if (existing?.stage === "HALTED") {
            return say(
              "This research run is halted; resume it first (`es factory resume` at a terminal, or /es-resume to preview).",
            )
          }
          if (existing?.stage === "DONE") {
            return say(
              "This research run is done. For a new question, start one in a fresh directory (`es research deep <question> --output <dir> --max-usd N` at a terminal).",
            )
          }
          if (!existing) {
            try {
              // The human typed /research deep: beginning the run is their action.
              await runtime.factory.beginResearchRun(
                { objective: query.replace(/--max-usd\s+[\d.]+/, "").trim(), ceilingUSD: Number(ceiling) },
                "human:tui",
              )
            } catch (error) {
              return say(`Could not start the research run: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          await ctx.session.switchAgent({ sessionID, agent: "deep-researcher" } as any)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${await runtime.factory.summary()}\nDeep research runs adversarially: write the plan note, launch es-research-alpha and es-research-beta in parallel (both subagent calls in one message, in the foreground), then es-research-synthesizer with the disputes, then es_research_audit and es_research_complete. No human will answer questions mid-flow.`,
            delivery,
          } as any)
        },
      })
      editor.add({
        name: "audit",
        description: "Open a code audit of the active phase or a path and run the auditor pair (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const target = prompt.text?.trim()
          const say = async (text: string) => {
            await ctx.session.synthetic({ sessionID, text } as any)
          }
          if (!target) return say("Usage: /audit <active phase id | path in the project>")
          const state = await runtime.factory.read().catch(() => undefined)
          if (state?.spendCeilingUSD === undefined)
            return say(
              "Audits run inside a factory run with a spend ceiling. Start one at a terminal with `es audit <target> --max-usd N`, or run /grill first.",
            )
          let opened: Awaited<ReturnType<typeof runtime.factory.openAudit>>
          try {
            // The human typed /audit: opening it is their action.
            opened = await runtime.factory.openAudit(
              "human:tui",
              parseAuditTarget(
                target,
                state.phases.map((phase) => phase.id),
              ),
            )
          } catch (error) {
            return say(`Could not open the audit: ${error instanceof Error ? error.message : String(error)}`)
          }
          const { audit } = opened
          await ctx.session.switchAgent({ sessionID, agent: "factory" } as any)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${await runtime.factory.summary()}\nThe human opened code audit ${audit.id} (round ${audit.round}) on ${describeTarget(audit.target)}. Launch es-auditor-thesis and es-auditor-antithesis in parallel with the audit id and target; if they split, have es-manager break the tie (es_tiebreak with audit). Report the verdicts and the report path when the audit settles.`,
            delivery,
          } as any)
        },
      })
      editor.add({
        name: "factory",
        description: "Drive the build factory from its current stage (Epistemic Swarm)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const state = await runtime.factory.read()
          if (!state) {
            await ctx.session.synthetic({
              sessionID,
              text: "No factory run here yet — run /grill first.",
            } as any)
            return
          }
          await ctx.session.switchAgent({ sessionID, agent: "factory" } as any)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${await runtime.factory.summary(state)}\nContinue the factory run from its current stage.${prompt.text?.trim() ? `\nHuman note: ${prompt.text}` : ""}`,
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
          const state = await runtime.factory.read()
          const liveness = await readLiveness(runtime.root, state)
          const text = [await runtime.factory.summary(state), ...livenessLines(state, liveness)].join("\n")
          await ctx.session.synthetic({ sessionID, text } as any)
        },
      })
      editor.add({
        name: "config",
        description: "Show the effective Epistemic Swarm config and where it came from (Epistemic Swarm)",
        execute: async ({ sessionID }) => {
          const lines = [
            runtime.configSources.length
              ? `Layers: ${runtime.configSources.join(" → ")} → plugin options`
              : "Layers: defaults only (no config files)",
            ...runtime.warnings.map((warning) => `Warning: ${warning}`),
            JSON.stringify(runtime.config, null, 2),
          ]
          await ctx.session.synthetic({ sessionID, text: lines.join("\n") } as any)
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
          await seats.onEvent(event, agentOf).catch(() => undefined)
          await bridge.onEvent(event, agentOf).catch(() => undefined)
          await continuation(event, agentOf).catch(() => undefined)
        }
      } catch {
        // stream closed on unload
      }
    })()
    return async () => {
      abort.abort()
      if (queued) clearTimeout(queued)
      await runtime.lsp.stopAll()
    }
  },
})
