// M0 TUI proof: load the probe through the same runtime Solid transform the
// OpenCode TUI installs, drive setup() with a recording context, then render
// the session.panel contribution headlessly with OpenTUI's test renderer.
import { expect, test } from "bun:test"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js"

ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } } })

test("TUI panel plugin compiles via the host transform and renders a session.panel", async () => {
  const slots: any[] = []
  const layers: any[] = []
  const toasts: any[] = []
  const opened: any[] = []
  const context: any = {
    options: {},
    theme: { text: { base: "#ffffff" } },
    ui: {
      slot: (claim: any) => (slots.push(claim), () => {}),
      toast: { show: (toast: any) => toasts.push(toast) },
      panel: { open: (name: string, options: any) => (opened.push({ name, options }), true), close() {}, current() {} },
    },
    keymap: { layer: (factory: any) => (layers.push(factory()), () => {}) },
  }
  const mod = await import("./plugins/tui-probe/tui.tsx")
  const plugin = mod.default as any
  expect(plugin.id).toBe("es.m0.tui-probe")
  plugin.setup(context)
  expect(toasts[0].message).toBe("es tui probe loaded")
  const command = layers[0].commands[0]
  expect(command.slash.name).toBe("es-dashboard")
  command.run()
  expect(opened[0]).toEqual({ name: mod.PANEL, options: { presentation: "fullscreen" } })

  const claim = slots.find((slot) => slot.append === "session.panel")
  const panel = { name: mod.PANEL, sessionID: "ses_probe", width: 80, presentation: "fullscreen", focused: true }
  const setup = await testRender(
    () =>
      createComponent(PluginContextProvider as any, {
        value: context,
        get children() {
          return claim.render(panel)
        },
      }),
    { width: 60, height: 6 },
  )
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("ES FACTORY DASHBOARD")
  expect(frame).toContain("session ses_probe")
  setup.renderer.destroy()
})
