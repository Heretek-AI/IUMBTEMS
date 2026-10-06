import { checkStopFile, evaluateWrite, FactoryStateMachine, recordApproval, runGates } from "@heretek-ai/es-core"
import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"

export default Plugin.define({
  id: "@heretek-ai/epistemic-swarm",
  async setup(ctx) {
    const cwd = process.cwd()

    // 1. Tool transformations (codemode: false, permission: es_*)
    await ctx.tool.transform((editor) => {
      // Factory Status
      editor.add({
        name: "es_factory_status",
        description: "Inspect current factory stage, active phase, spend, and retries",
        input: {
          type: "object",
          properties: {
            directory: { type: "string" },
          },
          additionalProperties: false,
        },
        options: { codemode: false, permission: "es_factory" as any },
        execute: async (input: any) => {
          const root = input?.directory ?? cwd
          try {
            const machine = await FactoryStateMachine.resume(root)
            return { content: JSON.stringify(machine.getState(), null, 2) }
          } catch (err: any) {
            return { content: JSON.stringify({ stage: "IDLE", message: err.message }) }
          }
        },
      })

      // Factory Init
      editor.add({
        name: "es_factory_init",
        description: "Initialize factory pipeline with a mandatory explicit spend ceiling in USD",
        input: {
          type: "object",
          properties: {
            spendCeilingUSD: {
              type: "number",
              description: "Maximum allowable cumulative spend ceiling in USD",
            },
            directory: { type: "string" },
          },
          required: ["spendCeilingUSD"],
          additionalProperties: false,
        },
        options: { codemode: false, permission: "es_factory" as any },
        execute: async (input: any) => {
          const root = input?.directory ?? cwd
          const machine = await FactoryStateMachine.init(root, input.spendCeilingUSD)
          return { content: JSON.stringify(machine.getState(), null, 2) }
        },
      })

      // Factory Advance
      editor.add({
        name: "es_factory_advance",
        description: "Advance the factory state machine to the next stage",
        input: {
          type: "object",
          properties: {
            qa_a_passed: { type: "boolean" },
            qa_b_passed: { type: "boolean" },
            managerTiebreak: { type: "string", enum: ["pass", "fail"] },
            touchedFiles: { type: "array", items: { type: "string" } },
            directory: { type: "string" },
          },
          additionalProperties: false,
        },
        options: { codemode: false, permission: "es_factory" as any },
        execute: async (input: any) => {
          const root = input?.directory ?? cwd
          try {
            const machine = await FactoryStateMachine.resume(root)
            const qaEval =
              input.qa_a_passed !== undefined
                ? {
                    qa_a_passed: Boolean(input.qa_a_passed),
                    qa_b_passed: Boolean(input.qa_b_passed),
                    managerTiebreak: input.managerTiebreak,
                    touchedFiles: input.touchedFiles,
                  }
                : undefined

            const next = await machine.advance(qaEval)
            return { content: JSON.stringify(next, null, 2) }
          } catch (err: any) {
            throw new ToolError({ message: `Factory advance refused: ${err.message}` })
          }
        },
      })

      // Gates Run
      editor.add({
        name: "es_gates_run",
        description: "Execute deterministic mechanical gates on workspace or touched files",
        input: {
          type: "object",
          properties: {
            touchedFiles: {
              type: "array",
              items: { type: "string" },
              description: "List of modified file paths to validate",
            },
            phaseId: { type: "string" },
            directory: { type: "string" },
          },
          additionalProperties: false,
        },
        options: { codemode: false, permission: "es_gates" as any },
        execute: async (input: any) => {
          const root = input?.directory ?? cwd
          const res = await runGates(root, {
            touchedFiles: input.touchedFiles,
            phaseId: input.phaseId,
          })
          return { content: JSON.stringify(res, null, 2) }
        },
      })

      // Human Approval
      editor.add({
        name: "es_approve",
        description: "Record human approval for a factory stage transition",
        input: {
          type: "object",
          properties: {
            stage: { type: "string" },
            phaseId: { type: "string" },
            artifactPath: { type: "string" },
            approvedBy: { type: "string" },
            spendCeilingConfirmed: { type: "number" },
            notes: { type: "string" },
          },
          required: ["stage", "artifactPath", "approvedBy"],
          additionalProperties: false,
        },
        options: { codemode: false, permission: "es_approve" as any },
        execute: async (input: any) => {
          try {
            const approval = await recordApproval(cwd, {
              stage: input.stage,
              phaseId: input.phaseId,
              artifactPath: input.artifactPath,
              approvedBy: input.approvedBy,
              spendCeilingConfirmed: input.spendCeilingConfirmed,
              notes: input.notes,
            })
            return { content: JSON.stringify(approval, null, 2) }
          } catch (err: any) {
            throw new ToolError({ message: `Approval failed: ${err.message}` })
          }
        },
      })
    })

    // 2. PreToolUse hook: block STOP file and unpermitted path writes
    await ctx.tool.hook("execute.before", async (event) => {
      // Check kill-file
      const stopCheck = await checkStopFile(cwd)
      if (stopCheck.stopped) {
        throw new ToolError({
          message: `Operation aborted: STOP kill-switch active (${stopCheck.reason}).`,
        })
      }

      // Check seat write permission on write/edit tools
      const toolName = event.tool.toLowerCase()
      if (toolName === "write" || toolName === "edit" || toolName === "patch") {
        const filePath = (event.input as any)?.path ?? (event.input as any)?.filePath
        if (typeof filePath === "string") {
          const decision = evaluateWrite({ root: ctx.location.directory }, event.agent, filePath)
          if (decision.effect === "deny") {
            throw new ToolError({ message: `Access Denied: ${decision.reason}` })
          }
        }
      }
    })

    // 3. Permission evaluate hook
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.resources.some((r) => r.includes(".factory/gates.json") || r.includes(".factory/STOP"))) {
        event.effect = "deny"
        event.message = "Direct manipulation of factory control files is prohibited."
      }
    })

    // 4. Commands
    await ctx.command.transform((editor) => {
      editor.add({
        name: "factory",
        description: "Inspect factory state or advance stages",
        execute: async (input: any) => {
          try {
            const machine = await FactoryStateMachine.resume(cwd)
            if (ctx.session?.synthetic) {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: JSON.stringify(machine.getState(), null, 2),
              })
            }
          } catch {
            if (ctx.session?.synthetic) {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: "Factory not initialized. Use es_factory_init to begin.",
              })
            }
          }
        },
      })

      editor.add({
        name: "gates",
        description: "Run mechanical verification gates",
        execute: async (input: any) => {
          const res = await runGates(cwd)
          if (ctx.session?.synthetic) {
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: res.summary,
            })
          }
        },
      })
    })
  },
})
