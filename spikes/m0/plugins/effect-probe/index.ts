// M0 probe (Effect API): exercises every extension point the 1.0 design relies on.
import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"

export const PROBE_SYSTEM = "ES-PROBE-SYSTEM-BLOCK"
export const PROBE_SUMMARY = "ES-PROBE-COMPACTION-SUMMARY"

export default Plugin.define({
  id: "es.m0.effect-probe",
  effect: Effect.fn(function* (ctx) {
    // Native tools, no MCP subprocess. codemode:false keeps them direct.
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "es_echo",
        description: "Echo text back",
        input: Schema.Struct({ text: Schema.String }),
        options: { codemode: false },
        execute: ({ text }) => Effect.succeed({ content: `echo:${text}` }),
      })
      editor.add({
        name: "es_fail",
        description: "Always fails with Tool.Error",
        input: Schema.Struct({}),
        options: { codemode: false },
        execute: () => Effect.fail(new Tool.Error({ message: "es_fail refused" })),
      })
      editor.add({
        name: "es_gated",
        description: "Tool with its own permission action",
        input: Schema.Struct({}),
        options: { codemode: false, permission: "es_gate" },
        execute: () => Effect.succeed({ content: "gated ran" }),
      })
    })

    // Blocking pre-tool hook: a Tool.Error rejects the call before it runs.
    yield* ctx.tool.hook("execute.before", (event) => {
      if (process.env.ES_DEBUG) console.log("EXEC-BEFORE", event.tool, JSON.stringify(event.input))
      const raw = JSON.stringify(event.input ?? {})
      if (raw.includes("BLOCKME"))
        return Effect.fail(new Tool.Error({ message: `blocked by es hook: ${event.tool}` }))
      return Effect.void
    })

    // Permission decisions: turn allow/ask into deny for a marked resource.
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        if (process.env.ES_DEBUG) console.log("PERM-EVAL", event.action, JSON.stringify(event.resources), event.effect)
        if (event.resources.some((resource) => resource.includes("DENYME"))) {
          event.effect = "deny"
          event.message = "denied by es permission hook"
        }
      }),
    )

    // Agents: a hidden subagent seat and a primary with wildcard-deny scoping.
    yield* ctx.agent.transform((editor) => {
      editor.update("es-seat" as any, (agent) => {
        agent.mode = "subagent"
        agent.hidden = true
        agent.description = "Hidden probe seat"
        agent.system = "You are the hidden probe seat."
      })
      editor.update("es-scoped" as any, (agent) => {
        agent.mode = "primary"
        agent.description = "Primary with scoped MCP and skills"
        agent.permissions = [
          ...agent.permissions,
          { action: "probe_*", resource: "*", effect: "deny" },
          { action: "probe_alpha", resource: "*", effect: "allow" },
          { action: "skill", resource: "*", effect: "deny" },
          { action: "skill", resource: "es-visible", effect: "allow" },
          { action: "es_gate", resource: "*", effect: "deny" },
        ]
      })
    })

    // Skills registered at runtime, no files written.
    yield* ctx.skill.transform((editor) => {
      editor.add({
        id: "es-visible" as any,
        name: "es-visible" as any,
        description: "Visible probe skill",
        path: "/tmp/es-visible/SKILL.md" as any,
        content: "visible skill body",
      })
      editor.add({
        id: "es-hidden" as any,
        name: "es-hidden" as any,
        description: "Hidden probe skill",
        path: "/tmp/es-hidden/SKILL.md" as any,
        content: "hidden skill body",
      })
    })

    // Websearch provider registered as the host default.
    yield* ctx.websearch.transform((editor) => {
      editor.add({
        id: "es-fake",
        name: "ES fake search",
        execute: (input: { query: string }) =>
          Effect.succeed([
            { url: "https://example.com/es", title: `result for ${input.query}`, content: "ES-SEARCH-CONTENT", time: {} },
          ] as any),
      } as any)
      editor.default.set("es-fake")
    })

    // Commands registered at runtime.
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "es-probe",
        description: "Probe command",
        execute: (input: any) =>
          ctx.session.synthetic({ sessionID: input.sessionID, text: "ES-COMMAND-RAN" } as any).pipe(Effect.asVoid, Effect.orDie),
      } as any)
    })

    // Context injection and compaction override.
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        event.system.push({ type: "text", text: PROBE_SYSTEM } as any)
      }),
    )
    yield* ctx.session.hook("compaction", (event) =>
      Effect.sync(() => {
        event.result = { summary: PROBE_SUMMARY }
      }),
    )

    // Shell pre-exec hook: rewrite the command.
    yield* ctx.shell.hook("create.before", (event) =>
      Effect.sync(() => {
        if (event.command.includes("ES_REWRITE")) event.command = "echo rewritten-by-es"
      }),
    )
  }),
})
