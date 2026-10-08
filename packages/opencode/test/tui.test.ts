// The TUI plugin loads through the host's runtime Solid transform and previews
// an approval, then points at the terminal (`es approve`) after confirm.
import { expect, test } from "bun:test"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } } })

function fakeContext(confirmAnswer: boolean, options: { canOpen?: boolean } = {}) {
  const calls: Array<[string, any]> = []
  const toasts: string[] = []
  const alerts: string[] = []
  const layers: any[] = []
  const slots: any[] = []
  const opened: string[] = []
  const presentations: string[] = []
  const closed: string[] = []
  const listeners = new Map<string, Array<(event: any) => void>>()
  const emit = (name: string, data: any) => {
    for (const listener of listeners.get(name) ?? []) listener({ data })
  }
  const rpc = new Proxy(
    {
      events: {
        on: (name: string, listener: (event: any) => void) => {
          listeners.set(name, [...(listeners.get(name) ?? []), listener])
          return () => {}
        },
      },
    },
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
        open: (name: string, open: { presentation?: string } = {}) => {
          if (options.canOpen === false) return false
          opened.push(name)
          presentations.push(open.presentation ?? "")
          return true
        },
        close: () => {
          closed.push("closed")
        },
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
  return { context, calls, toasts, alerts, layers, slots, opened, presentations, closed, emit }
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
    "es-close",
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

test("four panels claim session.panel, the footer claims prompt.footer.status, and commands open them beside the session", async () => {
  const plugin = (await import("../src/tui.tsx")).default as any
  const fx = fakeContext(true)
  plugin.setup(fx.context)

  expect(fx.slots.map((claim) => claim.append)).toEqual([
    "session.panel",
    "session.panel",
    "session.panel",
    "session.panel",
    "prompt.footer.status",
  ])
  for (const claim of fx.slots.slice(0, 4)) {
    // Each claim renders only for its own panel name (other names are null).
    expect(claim.render({ name: "other" })).toBeNull()
  }

  const commands = new Map(fx.layers[0].commands.map((command: any) => [command.id, command]))
  for (const name of ["factory", "lsp", "hooks", "brainstorm"]) {
    await commands.get(`es.panel.${name}`).run()
  }
  expect(fx.opened).toEqual(["factory", "lsp", "hooks", "brainstorm"])
  // A split panel by default (#57): the session stays visible; f toggles fullscreen inside the panel.
  expect(new Set(fx.presentations)).toEqual(new Set(["panel"]))
  await commands.get("es.panel.close").run()
  expect(fx.closed).toEqual(["closed"])
})

test("opening a panel off a session says why instead of doing nothing", async () => {
  const plugin = (await import("../src/tui.tsx")).default as any
  const fx = fakeContext(true, { canOpen: false })
  plugin.setup(fx.context)
  const commands = new Map(fx.layers[0].commands.map((command: any) => [command.id, command]))
  await commands.get("es.panel.factory").run()
  expect(fx.toasts).toContain("Open a session first: Epistemic Swarm panels show beside a session.")
})

test("changed events toast a stage change and announcements, not every refresh (#62)", async () => {
  const plugin = (await import("../src/tui.tsx")).default as any
  const fx = fakeContext(true)
  plugin.setup(fx.context)
  await Bun.sleep(0)
  fx.toasts.length = 0
  fx.emit("changed", { stage: "RESEARCH", summary: "" })
  fx.emit("changed", { stage: "RESEARCH", summary: "" })
  expect(fx.toasts).toEqual([])
  fx.emit("changed", { stage: "SPEC", summary: "" })
  fx.emit("changed", { stage: "SPEC", summary: "", notice: "Factory paused: 3 turns in SPEC without progress." })
  expect(fx.toasts).toEqual(["Factory → SPEC", "Factory paused: 3 turns in SPEC without progress."])
})
