// Regression tests for loading the PACKED TUI artifact the way the release
// host does. Two production realities are pinned here:
//
// 1. OpenCode installs npm plugins under a node_modules directory, where the
//    host's Solid transform does not apply (raw .tsx fell back to react-jsx
//    and failed on 'react'). The packed dist/tui.js must load from such a
//    path with only the host's runtime-module rewriting registered.
// 2. The slot claim entry point moved across host releases: opencode 2.0.x
//    exposes context.ui.slot, later hosts bare context.slot. Setup must work
//    with either and must not throw with neither (commands keep working).

import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { buildTui } from "../script/build-tui.ts"

ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } } })

async function loadPackedTui(): Promise<any> {
  const built = await buildTui()
  const fixture = mkdtempSync(path.join(tmpdir(), "es-tui-pack-"))
  const pluginDir = path.join(fixture, "node_modules", "packed-plugin")
  const destDir = path.join(pluginDir, "dist")
  mkdirSync(destDir, { recursive: true })
  copyFileSync(built, path.join(destDir, "tui.js"))
  writeFileSync(path.join(pluginDir, "package.json"), '{"type":"module"}')
  return (await import(pathToFileURL(path.join(destDir, "tui.js")).href)).default
}

function stubContext(shape: "release" | "later" | "none") {
  const slots: any[] = []
  const layers: any[] = []
  const rpc = new Proxy(
    { events: { on: () => () => {} } },
    {
      get(target: any, method: string) {
        if (method in target) return target[method]
        return async () => ({})
      },
    },
  )
  const slotFn = (claim: any) => {
    slots.push(claim)
    return () => {}
  }
  const context: any = {
    location: { directory: "/tmp/x" },
    data: { location: { default: () => ({ directory: "/tmp/x" }) } },
    client: { rpc: () => rpc },
    ui: {
      toast: { show: () => {} },
      dialog: {
        confirm: async () => false,
        alert: async () => {},
        select: async () => "frontier",
        prompt: async () => undefined,
      },
      panel: { open: () => true, close: () => {}, current: () => undefined },
    },
    keymap: {
      layer: (factory: any) => {
        layers.push(factory())
        return () => {}
      },
    },
  }
  if (shape === "later") context.slot = slotFn
  if (shape === "release") context.ui.slot = slotFn
  return { context, slots, layers }
}

for (const shape of ["release", "later"] as const) {
  test(`packed tui claims four session.panel slots via ${shape === "release" ? "ui.slot" : "bare slot"}`, async () => {
    const plugin = await loadPackedTui()
    expect(plugin.id).toBe("epistemic-swarm.tui")
    const fx = stubContext(shape)
    const cleanup = await plugin.setup(fx.context)
    expect(typeof cleanup === "function" || cleanup === undefined).toBe(true)
    expect(fx.slots).toHaveLength(4)
    for (const claim of fx.slots) {
      expect(claim.append).toBe("session.panel")
      expect(claim.render({ name: "other" })).toBeNull()
    }
    expect(fx.layers[0].commands.map((command: any) => command.slash.name)).toContain("es-approve")
  }, 60_000)
}

test("packed tui setup survives a host with no slot entry (commands still register)", async () => {
  const plugin = await loadPackedTui()
  const fx = stubContext("none")
  await plugin.setup(fx.context)
  expect(fx.slots).toHaveLength(0)
  expect(fx.layers[0].commands.map((command: any) => command.slash.name)).toContain("es-approve")
}, 60_000)
