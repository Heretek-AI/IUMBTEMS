#!/usr/bin/env node
// Launcher: Bun runs the TypeScript sources directly; Node runs the bundled build.
const entry = typeof Bun !== "undefined" ? "../src/main.ts" : "../dist/es.js"
const { main } = await import(new URL(entry, import.meta.url).href)
const { terminalIO } = await import(
  new URL(typeof Bun !== "undefined" ? "../src/tty.ts" : "../dist/es.js", import.meta.url).href
)
process.exit(
  await main(process.argv.slice(2), { print: (text) => console.log(text), confirm: terminalIO(), cwd: process.cwd() }),
)
