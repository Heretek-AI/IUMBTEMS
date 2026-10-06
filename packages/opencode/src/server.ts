// Epistemic Swarm for OpenCode v2 (server plugin). Additive: registers our
// agents, tools, skills, commands, hooks and RPC through runtime transforms;
// writes no config files and never touches built-in agents or defaults.
import { factorySummary, formatReport, git, loadSkills, runGates } from "@heretek-ai/es-core"
import { Plugin } from "@opencode/plugin"
import { compileAgents } from "./agents.ts"
import { createPolicyHooks } from "./policy.ts"
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

    const policy = createPolicyHooks(runtime)
    await ctx.tool.hook("execute.before", policy.before as any)
    await ctx.tool.hook("execute.after", policy.after as any)
    await ctx.permission.hook("evaluate", policy.evaluate as any)
    await ctx.shell.hook("create.before", policy.shellEnv)

    const session = createSessionHooks(runtime)
    await ctx.session.hook("context", session.context as any)
    await ctx.session.hook("compaction", session.compaction as any)

    // Human-only channel for the TUI (approvals, trust, resume).
    let registration: { events: { emit: (...args: any[]) => Promise<void> } } | undefined
    const notify = async () => {
      const state = await runtime.factory.read()
      await registration?.events
        .emit("changed", { stage: state?.stage ?? "NONE", summary: factorySummary(state) })
        .catch(() => undefined)
    }
    registration = await ctx.rpc.register(EsRpc, createRpcHandlers(runtime, notify) as any)

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
        name: "status",
        description: "Show the factory state (Epistemic Swarm)",
        execute: async ({ sessionID }) => {
          await ctx.session.synthetic({ sessionID, text: factorySummary(await runtime.factory.read()) } as any)
        },
      })
    })

    // Spend: per-step host cost for factory-agent sessions (estimated from tokens when cost is 0).
    const track = createSpendTracker(
      runtime,
      async (sessionID) => ((await ctx.session.get({ sessionID } as any)) as any)?.agent,
    )
    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal }) as AsyncIterable<any>)
          await track(event).catch(() => undefined)
      } catch {
        // stream closed on unload
      }
    })()
    return () => abort.abort()
  },
})
