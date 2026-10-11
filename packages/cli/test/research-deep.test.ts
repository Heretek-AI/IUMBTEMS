// #189: the CLI deep run (fake driver, no spend) through render: a finished
// run's dossier shows every claim's tag, quote, source and seal in both
// formats. The fake driver plays the seats through the real research tools,
// so this pins the deep → render flow, not the renderer (see render.test.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sealHumanKey } from "@heretek-ai/es-core"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

const PASSPHRASE = "test-passphrase-189"

let root: string
let state: string
const realXdgConfig = process.env.XDG_CONFIG_HOME

async function git(...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-cli-deep-"))
  state = await mkdtemp(path.join(tmpdir(), "es-cli-deep-state-"))
  process.env.XDG_CONFIG_HOME = path.join(state, "xdg-config")
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# x\n")
  await sealHumanKey(PASSPHRASE, state)
})

afterEach(async () => {
  if (realXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = realXdgConfig
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const human = (): ConfirmIO => ({
  interactive: true,
  write: () => {},
  readLine: async () => "",
  readSecret: async () => PASSPHRASE,
})
const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }

async function run(argv: string[], confirm: ConfirmIO, cwd: string) {
  const printed: string[] = []
  const code = await main(argv, { print: (text) => printed.push(text), confirm, cwd, stateDir: state })
  return { code, out: printed.join("\n") }
}

describe("es research deep renders a grounded dossier (#189)", () => {
  test("a fake-driver run to DONE renders every claim with tag, quote, source and seal", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    const { Factory, gateRunner, researchTools } = await import("@heretek-ai/es-core")
    const out = path.join(root, "out")
    // The output dir is its own project: render resolves the run through the
    // enclosing git toplevel, like a real `--output <dir>` fresh directory.
    await mkdir(out, { recursive: true })
    const init = Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: out, stdout: "pipe", stderr: "pipe" })
    await init.exited
    const stubFetch = (async () =>
      new Response("<p>Queues decouple workers from producers durably.</p>", {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch
    DRIVERS.fake = {
      id: "fake",
      available: async () => true,
      async *turn() {
        yield { text: "working" }
        // Thesis gathers, antithesis finds nothing, the synthesizer resolves —
        // through the real tools, sealed with the test state dir.
        const tools = researchTools({
          root: out,
          fetch: stubFetch,
          stateDir: state,
          policy: async () => ({ root: out }),
        })
        const fetched = await tools
          .find((tool) => tool.name === "es_research_fetch")!
          .execute({ url: "https://192.0.2.1/queues" }, { agent: "es-research-alpha" })
        const sha = /sha256:([0-9a-f]{64})/.exec(fetched)?.[1]
        expect(sha).toBeDefined()
        const thesis = `- Queues decouple workers [VERIFIED: sha256:${sha} "decouple workers from producers"]`
        const antithesis = `- No outage reports cached [NEGATIVE_KNOWLEDGE: searched for queue outages]`
        await writeFile(path.join(out, ".factory/research/alpha.md"), `# Alpha\n\n${thesis}\n`)
        await writeFile(path.join(out, ".factory/research/beta.md"), `# Beta\n\n${antithesis}\n`)
        await writeFile(path.join(out, ".factory/research/REPORT.md"), `# Report\n\n${thesis}\n${antithesis}\n`)
        await new Factory(out, { gates: gateRunner({ stateDir: state }), stateDir: state }).completeResearch(
          "deep-researcher",
        )
        return "ses_fake"
      },
    }
    try {
      const driven = await run(
        ["research", "deep", "what queue", "--output", "out", "--max-usd", "5", "--driver", "fake"],
        human(),
        root,
      )
      expect(driven.code).toBe(0)
      expect(driven.out).toContain("Research complete: out/.factory/research/REPORT.md")
      const done = await new Factory(out, { gates: gateRunner({ stateDir: state }), stateDir: state }).read()
      expect(done).toMatchObject({ mode: "research", stage: "DONE" })

      const md = await run(["research", "render", "--format", "md"], pipe, out)
      expect(md.code).toBe(0)
      for (const needle of [
        "Queues decouple workers",
        "VERIFIED",
        "No outage reports cached",
        "NEGATIVE_KNOWLEDGE",
        "decouple workers from producers",
        "https://192.0.2.1/queues",
        "sealed",
      ])
        expect([needle, md.out.includes(needle)]).toEqual([needle, true])

      const html = await run(["research", "render", "--format", "html", "--out", "dossier.html"], pipe, out)
      expect(html.code).toBe(0)
      const file = await Bun.file(path.join(out, "dossier.html")).text()
      for (const needle of [
        "<!doctype html>",
        "Queues decouple workers",
        "VERIFIED",
        "decouple workers from producers",
        "https://192.0.2.1/queues",
        "sealed",
      ])
        expect([needle, file.includes(needle)]).toEqual([needle, true])
    } finally {
      delete DRIVERS.fake
    }
  })
})
