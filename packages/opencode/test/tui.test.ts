// The TUI plugin loads through the host's runtime Solid transform and previews
// an approval, then points at the terminal (`es approve`) after confirm.
import { expect, test } from "bun:test"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } } })

function fakeContext(confirmAnswer: boolean) {
  const calls: Array<[string, any]> = []
  const toasts: string[] = []
  const alerts: string[] = []
  const layers: any[] = []
  const slots: any[] = []
  const opened: string[] = []
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
          if (method === "configState")
            return { config: "{}", sources: [], warnings: ["Ignored unknown plugin option: mode."] }
          return {}
        }
      },
    },
  )
  const context: any = {
    location: { directory: "/tmp/x" },
    data: { location: { default: () => ({ directory: "/tmp/x" }) } },
    client: { rpc: () => rpc },
    slot: (claim: any) => {
      slots.push(claim)
      return () => {}
    },
    ui: {
      toast: { show: (toast: any) => toasts.push(toast.message) },
      dialog: {
        confirm: async () => confirmAnswer,
        alert: async (input: any) => {
          alerts.push(typeof input === "string" ? input : (input?.message ?? JSON.stringify(input)))
        },
        select: async () => "frontier",
        prompt: async () => undefined,
      },
      panel: {
        open: (name: string) => {
          opened.push(name)
          return true
        },
        close: () => {},
        current: () => undefined,
      },
    },
    keymap: {
      layer: (factory: any) => {
        layers.push(factory())
        return () => {}
      },
    },
  }
  return { context, calls, toasts, alerts, layers, slots, opened }
}

test("slash commands register; approval goes preview → confirm → terminal alert", async () => {
  const plugin = (await import("../src/tui.tsx")).default as any
  const confirmed = fakeContext(true)
  plugin.setup(confirmed.context)
  // Load warnings are fetched once at startup and shown as a toast.
  await Bun.sleep(0)
  expect(confirmed.calls.map(([method]) => method)).toEqual(["configState"])
  expect(confirmed.toasts).toContain("Ignored unknown plugin option: mode.")
  confirmed.calls.length = 0
  const commands = confirmed.layers[0].commands
  expect(commands.map((command: any) => command.slash.name)).toEqual([
    "es-approve",
    "es-trust",
    "es-resume",
    "es-status",
    "es-lsp-install",
    "es-factory",
    "es-lsp-panel",
    "es-hooks",
    "es-brainstorm",
  ])
  await commands[0].run()
  expect(confirmed.calls.map(([method]) => method)).toEqual(["status", "previewApproval"])
  expect(confirmed.alerts.join("\n")).toContain("es approve frontier")

  const cancelled = fakeContext(false)
  plugin.setup(cancelled.context)
  await cancelled.layers[0].commands[0].run()
  expect(cancelled.calls.map(([method]) => method).filter((method) => method !== "configState")).toEqual([
    "status",
    "previewApproval",
  ])
  expect(cancelled.alerts).toHaveLength(0)
})

test("four panels claim session.panel and their commands open them", async () => {
  const plugin = (await import("../src/tui.tsx")).default as any
  const fx = fakeContext(true)
  plugin.setup(fx.context)

  expect(fx.slots).toHaveLength(4)
  for (const claim of fx.slots) {
    expect(claim.append).toBe("session.panel")
    // Each claim renders only for its own panel name (other names are null).
    expect(claim.render({ name: "other" })).toBeNull()
  }

  const commands = new Map(fx.layers[0].commands.map((command: any) => [command.id, command]))
  for (const name of ["factory", "lsp", "hooks", "brainstorm"]) {
    await commands.get(`es.panel.${name}`).run()
  }
  expect(fx.opened).toEqual(["factory", "lsp", "hooks", "brainstorm"])
})
