#!/usr/bin/env node
// Launcher: Bun runs the TypeScript sources directly; Node runs the bundled build.
const entry = typeof Bun !== "undefined" ? "../src/bin.ts" : "../dist/bin.js"
const { main } = await import(new URL(entry, import.meta.url).href)
process.exitCode = await main(process.argv.slice(2))
