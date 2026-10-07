// Regression test for the npm-installed TUI load failure ("Cannot find
// package 'react'"). OpenCode installs npm plugins under a node_modules
// directory, where the host's Solid transform does not apply — so the test
// loads the PACKED artifact (dist/tui.js, pre-compiled at pack time) from a
// fixture path containing node_modules, with only the host's runtime-module
// rewriting registered. If raw JSX or an unresolvable import slips back in,
// this import fails exactly like the production TUI.

import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { buildTui } from "../script/build-tui.ts"

ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } } })

function stubContext() {
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
  const context: any = {
    location: { directory: "/tmp/x" },
    data: { location: { default: () => ({ directory: "/tmp/x" }) } },
    client: { rpc: () => rpc },
    slot: (claim: any) => {
      slots.push(claim)
      return () => {}
    },
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
  return { context, slots, layers }
}

test("packed tui loads from a node_modules path and claims the panels", async () => {
  const built = await buildTui()
  const fixture = mkdtempSync(path.join(tmpdir(), "es-tui-pack-"))
  const destDir = path.join(fixture, "node_modules", "packed-plugin", "dist")
  mkdirSync(destDir, { recursive: true })
  copyFileSync(built, path.join(destDir, "tui.js"))
  writeFileSync(path.join(fixture, "node_modules", "packed-plugin", "package.json"), '{"type":"module"}')

  const plugin = (await import(pathToFileURL(path.join(destDir, "tui.js")).href)).default as any
  expect(plugin.id).toBe("epistemic-swarm.tui")

  const fx = stubContext()
  const cleanup = await plugin.setup(fx.context)
  expect(typeof cleanup === "function" || cleanup === undefined).toBe(true)
  expect(fx.slots).toHaveLength(4)
  for (const claim of fx.slots) expect(claim.append).toBe("session.panel")
}, 60_000)
