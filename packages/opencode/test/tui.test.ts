// The TUI plugin loads through the host's runtime Solid transform and only
// redeems an approval token after the human confirms the preview dialog.
import { expect, test } from "bun:test"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } } })

function fakeContext(confirmAnswer: boolean) {
  const calls: Array<[string, any]> = []
  const toasts: string[] = []
  const layers: any[] = []
  const rpc = new Proxy(
    { events: { on: () => () => {} } },
    {
      get(target: any, method: string) {
        if (method in target) return target[method]
        return async (input: any) => {
          calls.push([method, input])
          if (method === "status")
            return { summary: "<factory-state>x</factory-state>", stage: "GRILL", pending: ["frontier"] }
          if (method === "previewApproval")
            return {
              ok: true,
              title: "Approve frontier?",
              lines: ["Spend ceiling: $5 USD"],
              problems: [],
              token: "tok-1",
            }
          if (method === "approve") return { message: "Approved frontier as tester." }
          return {}
        }
      },
    },
  )
  const context: any = {
    location: { directory: "/tmp/x" },
    data: { location: { default: () => ({ directory: "/tmp/x" }) } },
    client: { rpc: () => rpc },
    ui: {
      toast: { show: (toast: any) => toasts.push(toast.message) },
      dialog: {
        confirm: async () => confirmAnswer,
        alert: async () => {},
        select: async () => "frontier",
        prompt: async () => undefined,
      },
    },
    keymap: {
      layer: (factory: any) => {
        layers.push(factory())
        return () => {}
      },
    },
  }
  return { context, calls, toasts, layers }
}

test("slash commands register; approval goes preview → confirm → approve(token)", async () => {
  const plugin = (await import("../src/tui.tsx")).default as any
  const confirmed = fakeContext(true)
  plugin.setup(confirmed.context)
  const commands = confirmed.layers[0].commands
  expect(commands.map((command: any) => command.slash.name)).toEqual([
    "es-approve",
    "es-trust",
    "es-resume",
    "es-status",
    "es-lsp-install",
  ])
  await commands[0].run()
  expect(confirmed.calls.map(([method]) => method)).toEqual(["status", "previewApproval", "approve"])
  expect(confirmed.calls[2]![1]).toMatchObject({ stage: "frontier", token: "tok-1" })
  expect(confirmed.toasts).toContain("Approved frontier as tester.")

  const cancelled = fakeContext(false)
  plugin.setup(cancelled.context)
  await cancelled.layers[0].commands[0].run()
  expect(cancelled.calls.map(([method]) => method)).toEqual(["status", "previewApproval"])
})
