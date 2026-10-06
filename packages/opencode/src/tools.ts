// Epistemic Swarm tools for OpenCode v2: the harness-neutral core operations,
// registered as direct (codemode:false) tools, each under its own permission
// action so per-agent rules can hide it. Refusals become model-facing tool errors.
import { esTools, pendingApprovals } from "@heretek-ai/es-core"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { Runtime } from "./runtime.ts"

export function registerTools(editor: { add(tool: any): void }, runtime: Runtime) {
  for (const def of esTools(runtime))
    editor.add({
      name: def.name,
      description: def.description,
      input: def.input,
      options: { codemode: false, permission: def.name },
      execute: async (input: unknown, context: { agent: string; sessionID: string; signal: AbortSignal }) => {
        try {
          return { content: await def.execute(input ?? {}, context) }
        } catch (error) {
          if (error instanceof ToolError) throw error
          throw new ToolError({ message: error instanceof Error ? error.message : String(error) })
        }
      },
    })
}

export { pendingApprovals }
