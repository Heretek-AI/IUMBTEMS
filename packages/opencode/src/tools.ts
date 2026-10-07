// Epistemic Swarm tools for OpenCode v2: the harness-neutral core operations,
// registered as direct (codemode:false) tools, each under its own permission
// action so per-agent rules can hide it. Refusals become model-facing tool errors.
import {
  brainstormTools,
  designTools,
  esTools,
  harvestTools,
  lspTools,
  pendingApprovals,
  researchTools,
} from "@heretek-ai/es-core"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { Runtime } from "./runtime.ts"

export function registerTools(editor: { add(tool: any): void }, runtime: Runtime) {
  const lsp = lspTools({ root: runtime.root, manager: runtime.lsp, policy: () => runtime.policy() })
  const research = researchTools({
    root: runtime.root,
    policy: () => runtime.policy(),
    ...(runtime.options.searchProvider ? { provider: runtime.options.searchProvider } : {}),
  })
  const brainstorm = brainstormTools({ root: runtime.root })
  const harvest = harvestTools({ root: runtime.root, whitelist: runtime.config.licenseWhitelist })
  const design = designTools({ root: runtime.root })
  for (const def of [
    ...esTools({ ...runtime, lsp: runtime.lsp }),
    ...lsp,
    ...research,
    ...brainstorm,
    ...harvest,
    ...design,
  ])
    editor.add({
      name: def.name,
      description: def.description,
      input: def.input,
      // es_* tools each get their own action; LSP tools share "lsp" (navigation) and "lsp_rename" (writes).
      options: {
        codemode: false,
        permission: def.name.startsWith("lsp_") ? (def.name === "lsp_rename" ? "lsp_rename" : "lsp") : def.name,
      },
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
