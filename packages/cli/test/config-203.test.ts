// Audit #203 — `es config set` is human-only: without a terminal it refuses
// before writing. These are pipe runs asserting refusal codes through the
// CLI's own seam (main with a non-interactive ConfirmIO); the human key is
// never unlocked and nothing is ever written.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exists, factoryLayout } from "@heretek-ai/es-core"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

let root: string
let state: string
const realXdgConfig = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-203-config-"))
  state = await mkdtemp(path.join(tmpdir(), "es-203-config-state-"))
  process.env.XDG_CONFIG_HOME = path.join(state, "xdg-config")
})
afterEach(async () => {
  if (realXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = realXdgConfig
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }

async function run(argv: string[]) {
  const printed: string[] = []
  const code = await main(argv, { print: (text) => printed.push(text), confirm: pipe, cwd: root, stateDir: state })
  return { code, out: printed.join("\n") }
}

describe("es config set refuses without a terminal (#203)", () => {
  test("a piped project-layer set refuses with code 3 and writes nothing", async () => {
    const result = await run(["config", "set", "research.depth", "3"])
    expect(result.code).toBe(3)
    expect(result.out).toContain("interactive terminal")
    expect(await exists(factoryLayout(root).config)).toBe(false)
  })

  test("a piped global-layer set refuses with code 3 and writes nothing", async () => {
    const result = await run(["config", "set", "research.depth", "3", "--global"])
    expect(result.code).toBe(3)
    expect(result.out).toContain("interactive terminal")
    expect(await exists(factoryLayout(root).config)).toBe(false)
    expect(await exists(path.join(state, "xdg-config", "epistemic-swarm", "config.json"))).toBe(false)
  })

  test("refusal codes contrast: schema refusal (1) precedes the TTY gate (3); usage is (2)", async () => {
    const typo = await run(["config", "set", "reserch.depth", "3"])
    expect(typo.code).toBe(1)
    expect(typo.out).toContain("Refused")
    const bad = await run(["config", "set", "research.depth", "9"])
    expect(bad.code).toBe(1)
    const usage = await run(["config", "set", "research.depth"])
    expect(usage.code).toBe(2)
    expect(await exists(factoryLayout(root).config)).toBe(false)
  })

  test("--help stays a read: usage, code 0, nothing written", async () => {
    const helped = await run(["config", "set", "research.depth", "3", "--help"])
    expect(helped.code).toBe(0)
    expect(await exists(factoryLayout(root).config)).toBe(false)
  })
})
