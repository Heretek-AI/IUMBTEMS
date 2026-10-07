// M0 probe (Promise API): does a thrown error in execute.before block, and how
// does the session surface it?
import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"

export default Plugin.define({
  id: "es.m0.promise-probe",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "es_p_echo",
        description: "Echo text back (promise)",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: (input: any) => Promise.resolve({ content: `p-echo:${input.text}` }),
      })
      editor.add({
        name: "es_p_throw",
        description: "Throws from a promise executor",
        input: { type: "object", properties: {} },
        options: { codemode: false },
        execute: () => Promise.reject(new ToolError({ message: "es_p_throw refused" })),
      })
    })
    await ctx.tool.hook("execute.before", (event) =>
      JSON.stringify(event.input ?? {}).includes("PBLOCK")
        ? Promise.reject(new ToolError({ message: "promise hook block" }))
        : Promise.resolve(),
    )
  },
})
