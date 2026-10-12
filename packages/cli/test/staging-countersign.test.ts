// CLI human-terminal countersign path (#345): `es staging countersign`
// mints an UNSIGNED cut and countersigns it with the passphrase-unlocked
// human key at an interactive terminal. Agents may request, never grant:
// a non-terminal caller is refused before any signing (human-only policy
// at the CLI layer; shell-policy HUMAN_VERBS wiring is a follow-up).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sealHumanKey } from "@heretek-ai/es-core"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

const PASSPHRASE = "test-passphrase-1234"

let root: string
let state: string
const realXdgConfig = process.env.XDG_CONFIG_HOME
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-staging-cli-"))
  state = await mkdtemp(path.join(tmpdir(), "es-staging-cli-state-"))
  process.env.XDG_CONFIG_HOME = path.join(state, "xdg-config")
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# x\n")
  await git("add", "-A")
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  await sealHumanKey(PASSPHRASE, state)
})
afterEach(async () => {
  if (realXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = realXdgConfig
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

/** A human at a terminal who types the passphrase with echo off. */
const human = (answer: string = PASSPHRASE): ConfirmIO & { output: string[] } => {
  const output: string[] = []
  return {
    interactive: true,
    output,
    write: (text) => output.push(text),
    readLine: async () => "",
    readSecret: async () => answer,
  }
}
const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }

async function run(argv: string[], confirm: ConfirmIO = pipe) {
  const printed: string[] = []
  const code = await main(argv, { print: (text) => printed.push(text), confirm, cwd: root, stateDir: state })
  return { code, out: printed.join("\n") }
}

describe("es staging countersign (#345, human-only)", () => {
  test("a non-terminal caller is refused before any signing", async () => {
    const { code, out } = await run(["staging", "countersign", "--title", "Release 2.5.0", "--body", "Notes."])
    expect(code).toBe(3)
    expect(out).toMatch(/interactive terminal/i)
  })

  test("missing title/body prints usage without signing", async () => {
    const { code, out } = await run(["staging", "countersign", "--title", "Release 2.5.0"], human())
    expect(code).toBe(2)
    expect(out).toMatch(/Usage/i)
  })

  test("a human at a terminal countersigns with the unlocked key", async () => {
    const { code, out } = await run(["staging", "countersign", "--title", "Release 2.5.0", "--body", "Notes."], human())
    expect(code).toBe(0)
    expect(out).toMatch(/signed/i)
    expect(out).toMatch(/human:/i)
  })

  test("a cancelled passphrase signs nothing", async () => {
    const { code, out } = await run(
      ["staging", "countersign", "--title", "Release 2.5.0", "--body", "Notes."],
      human(""),
    )
    expect(code).toBe(1)
    expect(out).toMatch(/cancelled/i)
  })

  test("--help is side-effect free for agents", async () => {
    const { code, out } = await run(["staging", "countersign", "--help"])
    expect(code).toBe(0)
    expect(out).toMatch(/countersign/i)
  })
})
