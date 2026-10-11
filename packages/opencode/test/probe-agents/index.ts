import { writeFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"

// Test fixture for registry-host.test.ts (#228): snapshots the host's agent
// list after every plugin's agent.transform ran, so the test can diff the
// vanilla baseline against the plugged host (built-ins and defaults
// untouched, registry agents added with their hidden flags).
export default Plugin.define({
  id: "es-probe-agents",
  async setup(ctx: any) {
    const out = ctx.options?.out as string | undefined
    if (!out) return
    await ctx.agent.transform((editor: any) => {
      const list = editor.list().map((agent: any) => ({
        id: agent.id ?? agent.name,
        hidden: !!agent.hidden,
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.description !== undefined ? { description: agent.description } : {}),
      }))
      writeFileSync(out, `${JSON.stringify({ list, at: new Date().toISOString() }, null, 2)}\n`)
    })
  },
})
