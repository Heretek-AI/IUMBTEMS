import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  exists,
  Factory,
  factoryLayout,
  gateRunner,
  HUMAN_VERBS,
  parseArgs,
  readApproval,
  researchSourcesDir,
  SourceCache,
  sealHumanKey,
} from "@heretek-ai/es-core"
import { parseExpiry } from "../src/args.ts"
import { type HarnessDriver, type HeadlessEvent, presentEvent, runHeadless } from "../src/headless.ts"
import { commandHelp, main } from "../src/main.ts"
import { createMcpServer } from "../src/mcp.ts"
import { type ConfirmIO, confirmHuman, NotInteractive } from "../src/tty.ts"
import { VERSION } from "../src/version.ts"

const PASSPHRASE = "test-passphrase-1234"

let root: string
let state: string
// The global config layer lives under XDG_CONFIG_HOME: point it into the
// test's state dir so `--global` never touches the real ~/.config.
const realXdgConfig = process.env.XDG_CONFIG_HOME
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-cli-"))
  state = await mkdtemp(path.join(tmpdir(), "es-cli-state-"))
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

/** A human at a terminal who types the passphrase with echo off (or `answer`). */
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

async function grilledFrontier() {
  const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
  await factory.writeFrontier("grill", {
    version: "1.1",
    idea: "cli test",
    spendCeiling: { currency: "USD", maxAmount: 3 },
    settled: true,
    nodes: [{ id: "a", question: "q?", answer: "yes", status: "settled" }],
  })
  return factory
}

describe("args", () => {
  test("flags, booleans and expiry", () => {
    expect(parseArgs(["gates", "run", "--full", "a.ts", "--base", "main"], ["full"])).toEqual({
      positionals: ["gates", "run", "a.ts"],
      flags: { full: true, base: "main" },
    })
    const now = new Date("2026-10-06T00:00:00Z")
    expect(parseExpiry("7d", now).toISOString()).toBe("2026-10-13T00:00:00.000Z")
    expect(() => parseExpiry("soon")).toThrow()
  })
})

describe("HELP human-only markers match HUMAN_VERBS (#97)", () => {
  // Every human-only command line carries an explicit [human, TTY] (or
  // [human]) marker; section headers do not count. Placeholders (<…>, […],
  // "…") are not literal sub-verbs and are skipped.
  const literal = (word: string | undefined): string | undefined =>
    word !== undefined && /^[A-Za-z][\w.-]*$/.test(word) ? word : undefined
  const commands = () => {
    const help = commandHelp("no-such-command")
    const rows: Array<{ verb: string; sub: string | undefined; marked: boolean; line: string }> = []
    for (const line of help.split("\n")) {
      const match = /^ {2}(\S+)(?:\s+(\S+))?/.exec(line)
      if (!match) continue
      rows.push({
        verb: match[1]!,
        sub: literal(match[2]),
        marked: /\[human[^\]]*\]/.test(line),
        line: line.trim(),
      })
    }
    return rows
  }

  test("every marked verb is human-only, and every human-only verb is marked", () => {
    const rows = commands()
    expect(rows.length).toBeGreaterThan(20)
    const names = new Set(HUMAN_VERBS.map(([name]) => name))
    for (const row of rows.filter((item) => item.marked)) {
      expect([row.line, names.has(row.verb)]).toEqual([row.line, true])
      const [, predicate] = HUMAN_VERBS.find(([name]) => name === row.verb)!
      if (row.sub !== undefined && predicate !== undefined)
        expect([row.line, predicate(row.sub)]).toEqual([row.line, true])
    }
    // Bare "resume" has no top-level CLI command (only factory resume); the
    // rule stays as over-approximation for other binaries. Every verb HELP
    // documents as a command must show a marker.
    for (const [name] of HUMAN_VERBS)
      if (name !== "resume" && rows.some((row) => row.verb === name))
        expect([name, rows.some((row) => row.marked && row.verb === name)]).toEqual([name, true])
  })

  test("a literal sub-verb the rule calls human-only is never left unmarked", () => {
    const rows = commands()
    const unmarked: string[] = []
    for (const [name, predicate] of HUMAN_VERBS) {
      if (predicate === undefined) continue
      const literalSubs = new Set(
        rows.filter((row) => row.verb === name && row.sub !== undefined).map((row) => row.sub!),
      )
      for (const sub of literalSubs)
        if (predicate(sub) && !rows.some((row) => row.verb === name && row.sub === sub && row.marked))
          unmarked.push(`${name} ${sub}`)
    }
    expect(unmarked).toEqual([])
  })
})

describe("--help (#59)", () => {
  test("`es <command> --help` prints that command's usage; any --help value means help", async () => {
    const reseal = await run(["reseal", "--help"])
    expect(reseal.code).toBe(0)
    expect(reseal.out).toContain("reseal [--sign]")
    expect(reseal.out).not.toContain("approve <frontier|spec>")
    const factory = await run(["factory", "--help"])
    expect(factory.out).toContain("factory run --headless")
    expect(factory.out).toContain("[--log-level quiet|info|debug]")
    expect(factory.out).toContain("factory resume")
    expect((await run(["--help"])).out).toContain("Usage: es [--cwd <dir> | --run <run id>] <command>")
    expect((await run(["nonsense", "--help"])).out).toContain("Usage: es [--cwd")
    // `--help=x` never falls through to the command: nothing is approved or created.
    const approve = await run(["approve", "frontier", "--help=no"], human())
    expect(approve.code).toBe(0)
    expect(approve.out).toContain("approve <frontier|spec>")
    expect(await exists(factoryLayout(root).dir)).toBe(false)
  })
})

describe("human-only confirmation", () => {
  test("needs a TTY and the correct passphrase", async () => {
    await expect(confirmHuman(pipe, "x", [], state)).rejects.toBeInstanceOf(NotInteractive)
    expect(await confirmHuman(human("wrong-passphrase"), "x", [], state)).toBeUndefined()
    expect(await confirmHuman(human(""), "x", [], state)).toBeUndefined()
    expect(await confirmHuman(human(), "x", [], state)).toBeDefined()
  })

  test("es approve refuses without a terminal and records nothing", async () => {
    await grilledFrontier()
    const result = await run(["approve", "frontier"])
    expect(result.code).toBe(3)
    expect(await readApproval(root, "frontier")).toBeUndefined()
  })

  test("es approve frontier at a terminal signs it and starts research", async () => {
    const factory = await grilledFrontier()
    const io = human()
    const result = await run(["approve", "frontier"], io)
    expect(result.code).toBe(0)
    expect(io.output.join("")).toContain("Spend ceiling: $3 USD")
    expect((await readApproval(root, "frontier"))?.channel).toBe("cli")
    expect((await factory.read())?.stage).toBe("RESEARCH")
  })

  test("a wrong or empty passphrase records nothing (a PTY cannot approve)", async () => {
    await grilledFrontier()
    for (const answer of ["", "wrong-passphrase"]) {
      const result = await run(["approve", "frontier"], human(answer))
      expect(result.code).toBe(1)
      expect(await readApproval(root, "frontier")).toBeUndefined()
    }
    const granted = await run(["approve", "frontier"], human())
    expect(granted.code).toBe(0)
    expect((await readApproval(root, "frontier"))?.channel).toBe("cli")
  })

  test("a wrong passphrase cancels the waiver", async () => {
    const result = await run(["waive", "lint/*", "--reason", "legacy code under migration"], human("nope-wrong-pass"))
    expect(result.code).toBe(1)
    const granted = await run(
      ["waive", "lint/*", "--reason", "legacy code under migration", "--expires", "2d"],
      human(),
    )
    expect(granted.code).toBe(0)
    expect(granted.out).toContain("granted")
  })
})

describe("es key", () => {
  test("seal asks twice, refuses short or mismatched passphrases, and status shows the fingerprint", async () => {
    const { humanKeyId } = await import("@heretek-ai/es-core")
    // beforeEach already sealed `state`; use a fresh dir for seal flows.
    const fresh = await mkdtemp(path.join(tmpdir(), "es-key-"))
    try {
      const runIn = async (argv: string[], confirm: ConfirmIO) => {
        const printed: string[] = []
        const code = await main(argv, { print: (text) => printed.push(text), confirm, cwd: root, stateDir: fresh })
        return { code, out: printed.join("\n") }
      }
      const seq = (answers: string[]): ConfirmIO & { output: string[] } => {
        const output: string[] = []
        const queue = [...answers]
        return {
          interactive: true,
          output,
          write: (text) => output.push(text),
          readLine: async () => "",
          readSecret: async () => queue.shift() ?? "",
        }
      }
      expect((await runIn(["key", "seal"], seq(["short", "short"]))).code).toBe(1)
      expect((await runIn(["key", "seal"], seq(["long-enough-pass", "different-pass"]))).code).toBe(1)
      expect(await humanKeyId(fresh)).toBeUndefined()
      expect((await runIn(["key", "seal"], seq(["a-long-test-passphrase", "a-long-test-passphrase"]))).code).toBe(0)
      expect(await humanKeyId(fresh)).toBeDefined()
      expect((await runIn(["key", "status"], seq([]))).out).toContain("Human key")
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
    expect((await run(["key", "status"], human())).out).toContain("Human key")
  })
})

describe("research brief and retractions", () => {
  async function researched() {
    const { buildDossier, normalizeClaim, researchSourcesDir, SourceCache, writeDossier } = await import(
      "@heretek-ai/es-core"
    )
    const cache = new SourceCache(researchSourcesDir(root), state)
    const source = await cache.put({
      url: "https://x.test/cli",
      text: "The CLI exports a signed brief that anyone holding the key can verify.",
      provider: "fetch",
    })
    const claim = normalizeClaim({
      tag: "VERIFIED",
      statement: "Briefs are signed.",
      source: { sha256: source.meta.sha256, quote: "exports a signed brief" },
    })
    await writeFile(path.join(root, ".factory/research/REPORT.md"), "# R\n")
    await writeDossier(
      factoryLayout(root).researchDossier,
      buildDossier({ mode: "research", subject: "cli", claims: [claim] }),
      { cache },
    )
    return source.meta.sha256
  }

  test("export writes a signed brief that verify-brief accepts, and a tampered one fails", async () => {
    await researched()
    expect((await run(["research", "export", "--help"])).code).toBe(0)
    expect(await exists(factoryLayout(root).researchBrief)).toBe(false)
    expect((await run(["research", "export"])).code).toBe(3)
    expect(await exists(factoryLayout(root).researchBrief)).toBe(false)
    const exported = await run(["research", "export"], human())
    expect(exported.code).toBe(0)
    expect(exported.out).toContain("Exported .factory/research/brief.pcrb.json")
    const verified = await run(["research", "verify-brief", ".factory/research/brief.pcrb.json"])
    expect([verified.code, verified.out.split("\n")[0]]).toEqual([
      0,
      "Brief OK: source identity pass, manifest pass, signature valid, quotes pass",
    ])
    const file = factoryLayout(root).researchBrief
    const brief = JSON.parse(await Bun.file(file).text())
    brief.claims[0].statement = "Briefs are unsigned."
    await writeFile(path.join(root, "tampered.json"), JSON.stringify(brief))
    const tampered = await run(["research", "verify-brief", "tampered.json"])
    expect(tampered.code).toBe(1)
    expect(tampered.out).toContain("Brief FAILED")
    expect((await run(["research", "verify-brief"])).code).toBe(2)
  })

  test("retract is human-only and degrades the claims that cite the source", async () => {
    const { ClaimStore } = await import("@heretek-ai/es-core")
    const source = await researched()
    expect((await run(["research", "retract", source, "--event", "retracted"])).code).toBe(3)
    expect(await exists(factoryLayout(root).retractions)).toBe(false)
    expect((await run(["research", "retract", "abc", "--event", "retracted"], human())).code).toBe(2)
    expect((await run(["research", "retract", source, "--event", "maybe"], human())).code).toBe(2)
    const recorded = await run(["research", "retract", source, "--event", "retracted", "--note", "withdrawn"], human())
    expect(recorded.code).toBe(0)
    expect(recorded.out).toContain("1 claim(s) citing")
    expect((await ClaimStore.load(root)).citing(source).map((claim) => claim.status)).toEqual(["STALE"])
  })

  test("render is agent-safe: md and html to stdout or a file", async () => {
    const source = await researched()
    expect((await run(["research", "render", "--format", "bogus"])).code).toBe(2)
    const md = await run(["research", "render", "--format", "md"])
    expect(md.code).toBe(0)
    expect(md.out).toContain("# Research dossier: cli")
    expect(md.out).toContain("Briefs are signed.")
    expect(md.out).toContain(source.slice(0, 12))
    const html = await run(["research", "render", "--format", "html", "--out", "dossier.html"])
    expect(html.code).toBe(0)
    expect(html.out).toContain("Rendered dossier.html (html,")
    const file = await Bun.file(path.join(root, "dossier.html")).text()
    expect(file).toContain("<!doctype html>")
    expect(file).not.toContain("<script")
    expect((await run(["research", "render"])).code).toBe(0)
  })
})

describe("es research deep (headless deep research)", () => {
  test("usage without side effects; a ceiling needs a terminal", async () => {
    expect((await run(["research", "deep", "--help"])).code).toBe(0)
    expect(await exists(factoryLayout(root).dir)).toBe(false)
    const bare = await run(["research", "deep"])
    expect([bare.code, bare.out]).toEqual([2, expect.stringContaining("--max-usd N")])
    const noCeiling = await run(["research", "deep", "what queue", "--output", "out"])
    expect([noCeiling.code, noCeiling.out]).toEqual([2, expect.stringContaining("--max-usd")])
    const badModel = await run([
      "research",
      "deep",
      "what queue",
      "--output",
      "out",
      "--max-usd",
      "5",
      "--model",
      "nope",
    ])
    expect([badModel.code, badModel.out]).toEqual([2, expect.stringContaining("provider/model")])
    expect(await exists(factoryLayout(root).dir)).toBe(false)
    const { DRIVERS } = await import("../src/headless.ts")
    DRIVERS.fake = {
      id: "fake",
      available: async () => true,
      async *turn(_input: unknown) {
        yield { text: "unused" }
        return "ses_fake"
      },
    }
    try {
      // No TTY: the ceiling confirmation refuses before anything is created.
      // The fake driver pins the driver check, so this reads the same with
      // or without a harness binary installed.
      expect(
        (await run(["research", "deep", "what queue", "--output", "out", "--max-usd", "5", "--driver", "fake"])).code,
      ).toBe(3)
      expect(await exists(path.join(root, "out", ".factory"))).toBe(false)
    } finally {
      delete DRIVERS.fake
    }
  })

  test("a fake driver plays the coordinator flow to DONE", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    const { Factory, gateRunner, researchTools } = await import("@heretek-ai/es-core")
    const out = path.join(root, "out")
    const stubFetch = (async () =>
      new Response("<p>Queues decouple workers from producers durably.</p>", {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch
    const prompts: string[] = []
    DRIVERS.fake = {
      id: "fake",
      available: async () => true,
      async *turn({ prompt }: { prompt: string }) {
        yield { text: "working" }
        prompts.push(prompt)
        // Alpha gathers, beta finds nothing, the synthesizer resolves, the
        // coordinator completes — through the real tools and the real gate.
        const tools = researchTools({
          root: out,
          fetch: stubFetch,
          stateDir: state,
          policy: async () => ({ root: out }),
        })
        const fetched = await tools
          .find((tool) => tool.name === "es_research_fetch")!
          .execute({ url: "https://x.test/queues" }, { agent: "es-research-alpha" })
        const sha = /sha256:([0-9a-f]{64})/.exec(fetched)?.[1]
        await writeFile(
          path.join(out, ".factory/research/alpha.md"),
          `# Alpha\n\n- Queues decouple workers [VERIFIED: sha256:${sha} "decouple workers from producers"]\n`,
        )
        await writeFile(
          path.join(out, ".factory/research/beta.md"),
          "# Beta\n\n- No counter-evidence cached [NEGATIVE_KNOWLEDGE: searched for queue outages]\n",
        )
        await writeFile(
          path.join(out, ".factory/research/REPORT.md"),
          `# Report\n\n- Queues decouple workers [VERIFIED: sha256:${sha} "decouple workers from producers"]\n`,
        )
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
      )
      expect(driven.code).toBe(0)
      expect(driven.out).toContain("Research run run-")
      expect(driven.out).toContain("Research complete: out/.factory/research/REPORT.md")
      expect(prompts[0]).toContain("Deep research: what queue")
      expect(prompts[0]).toContain("es-research-alpha")
      const done = await new Factory(out, { gates: gateRunner({ stateDir: state }), stateDir: state }).read()
      expect(done).toMatchObject({ mode: "research", stage: "DONE" })
    } finally {
      delete DRIVERS.fake
    }
  })
})

describe("es config set", () => {
  const projectConfig = () => Bun.file(factoryLayout(root).config).json()

  test("is human-only, schema-validated, previewed, and re-pins the project config", async () => {
    const { verifyAuditChain, verifyControl, rebaseline } = await import("@heretek-ai/es-core")
    await rebaseline(root, "test")
    expect((await run(["config", "set", "research.depth", "3", "--help"])).code).toBe(0)
    expect((await run(["config", "set", "research.depth", "3"])).code).toBe(3)
    expect(await exists(factoryLayout(root).config)).toBe(false)
    const io = human()
    const set = await run(["config", "set", "research.depth", "3"], io)
    expect(set.code).toBe(0)
    expect(io.output.join("")).toContain("research.depth: (unset) → 3")
    expect(await projectConfig()).toEqual({ research: { depth: 3 } })
    expect((await verifyControl(root)).clean).toBe(true)
    const audit = await verifyAuditChain(root)
    expect(audit.entries.map((entry) => entry.action)).toContain("config.set")
    expect((await run(["config", "set", "research.depth", "3"], human())).out).toContain("already 3")
    expect((await run(["config", "show"])).out).toContain('"depth": 3')
  })

  test("audit.phase takes required in the project layer and rejects anything else (#33)", async () => {
    const { verifyControl, rebaseline } = await import("@heretek-ai/es-core")
    await rebaseline(root, "test")
    expect((await run(["config", "set", "audit.phase", "sometimes"], human())).code).toBe(1)
    const io = human()
    expect((await run(["config", "set", "audit.phase", "required"], io)).code).toBe(0)
    expect(io.output.join("")).toContain('audit.phase: (unset) → "required"')
    expect(await projectConfig()).toEqual({ audit: { phase: "required" } })
    expect((await verifyControl(root)).clean).toBe(true)
    expect((await run(["config", "show"])).out).toContain('"phase": "required"')
  })

  test("rejects unknown keys, invalid values and project-forbidden keys (those go --global)", async () => {
    const typo = await run(["config", "set", "reserch.depth", "3"], human())
    expect([typo.code, typo.out]).toEqual([1, expect.stringContaining("Refused")])
    expect((await run(["config", "set", "research.depth", "9"], human())).code).toBe(1)
    expect((await run(["config", "set", "afterEdit", "sometimes"], human())).code).toBe(1)
    const forbidden = await run(["config", "set", "research.searxngUrl", "https://search.test"], human())
    expect([forbidden.code, forbidden.out]).toEqual([1, expect.stringContaining("--global")])
    expect(await exists(factoryLayout(root).config)).toBe(false)
    const global = await run(["config", "set", "research.searxngUrl", "https://search.test", "--global"], human())
    expect(global.code).toBe(0)
    const file = path.join(state, "xdg-config", "epistemic-swarm", "config.json")
    expect(await Bun.file(file).json()).toEqual({ research: { searxngUrl: "https://search.test" } })
    expect((await run(["config", "set", "research.searxngUrl", "null", "--global"], human())).code).toBe(0)
    expect(await Bun.file(file).json()).toEqual({ research: {} })
    expect((await run(["config", "set", "research.depth"], human())).code).toBe(2)
  })

  test("never launders drift in other control files; accepts a pending hand edit to config.json only openly", async () => {
    const { rebaseline, verifyControl } = await import("@heretek-ai/es-core")
    await mkdir(factoryLayout(root).dir, { recursive: true })
    await writeFile(factoryLayout(root).config, '{"pr":"off"}\n')
    await rebaseline(root, "test")
    await writeFile(factoryLayout(root).gates, '{"version":1}\n')
    const refused = await run(["config", "set", "research.depth", "4"], human())
    expect([refused.code, refused.out]).toEqual([1, expect.stringContaining("es rebaseline")])
    expect(await projectConfig()).toEqual({ pr: "off" })
    await rebaseline(root, "test")
    await writeFile(factoryLayout(root).config, '{"pr":"gh"}\n')
    const io = human()
    expect((await run(["config", "set", "research.depth", "4"], io)).code).toBe(0)
    expect(io.output.join("")).toContain("accepted along with it")
    expect(await projectConfig()).toEqual({ pr: "gh", research: { depth: 4 } })
    expect((await verifyControl(root)).clean).toBe(true)
  })
})

describe("es reseal", () => {
  const stateFile = () => path.join(root, ".factory/runtime/state.json")
  const factory = () => new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })

  test("verifies engine sidecars; --sign re-signs reviewed files at a TTY", async () => {
    expect(await run(["reseal"])).toEqual({ code: 0, out: expect.stringContaining("No engine-signed files yet") })
    await factory().begin("human:tester")
    expect((await run(["reseal"])).out).toContain("state.json: ok")
    // Tamper outside the engine: verify reports it and the run refuses.
    await writeFile(stateFile(), `${await readFile(stateFile(), "utf8")} `)
    const bad = await run(["reseal"])
    expect(bad.code).toBe(1)
    expect(bad.out).toContain("signature mismatch")
    await expect(factory().read()).rejects.toThrow("signature mismatch")
    // Re-signing needs the human passphrase; a pipe cannot give it, a human signs.
    expect((await run(["reseal", "--sign"])).code).toBe(3)
    expect((await run(["reseal", "--sign"], human())).code).toBe(0)
    expect((await run(["reseal"])).out).toContain("state.json: ok")
    expect((await factory().read())!.stage).toBe("GRILL")
  })

  test("names the key it checks, and refuses to sign when it cannot see the engine key (#59)", async () => {
    await factory().begin("human:tester")
    expect((await run(["reseal"])).out).toContain(`Engine key: ${path.join(state, "engine.key")}`)
    const elsewhere = await mkdtemp(path.join(tmpdir(), "es-cli-elsewhere-"))
    try {
      const printed: string[] = []
      const code = await main(["reseal", "--sign"], {
        print: (text) => printed.push(text),
        confirm: human(),
        cwd: root,
        stateDir: elsewhere,
      })
      expect(code).toBe(1)
      expect(printed.join("\n")).toContain("This shell cannot see the engine key")
      expect(await exists(path.join(elsewhere, "engine.key"))).toBe(false)
      // The engine's own view is unchanged.
      expect((await factory().read())!.stage).toBe("GRILL")
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  test("adopts a legacy pre-sidecar run after review", async () => {
    await factory().begin("human:tester")
    await rm(`${stateFile()}.sig`)
    await expect(factory().read()).rejects.toThrow("es reseal")
    expect((await run(["reseal"])).out).toContain("missing sidecar")
    expect((await run(["reseal", "--sign"], human())).code).toBe(0)
    expect((await factory().read())!.stage).toBe("GRILL")
  })
})

describe("rebaseline", () => {
  test("es rebaseline needs a terminal and accepts hand edits to pinned control files", async () => {
    const { rebaseline, verifyControl } = await import("@heretek-ai/es-core")
    await rebaseline(root, "test")
    await mkdir(path.join(root, ".factory"), { recursive: true })
    await writeFile(path.join(root, ".factory/config.json"), '{"pr":"off"}')
    expect((await verifyControl(root)).clean).toBe(false)
    expect((await run(["rebaseline"])).code).not.toBe(0)
    expect((await verifyControl(root)).clean).toBe(false)
    const accepted = await run(["rebaseline"], human())
    expect(accepted.code).toBe(0)
    expect(accepted.out).toContain("Re-baselined 1")
    expect((await verifyControl(root)).clean).toBe(true)
  })
})

describe("gates and audit", () => {
  test("--help prints usage without minting a run", async () => {
    const helped = await run(["factory", "begin", "--help"])
    expect(helped.code).toBe(0)
    expect(helped.out).toContain("Usage: es")
    expect(await exists(factoryLayout(root).state)).toBe(false)
    expect(await exists(factoryLayout(root).dir)).toBe(false)
  })
  test("gates run exits non-zero on findings; audit verify reports the chain", async () => {
    await writeFile(path.join(root, "leak.ts"), `export const t = "ghp_${"Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"}"\n`)
    const gates = await run(["gates", "run", "leak.ts"])
    expect(gates.code).toBe(1)
    expect(gates.out).toContain("security/secret-github-token")
    await grilledFrontier()
    expect((await run(["audit", "verify"])).out).toContain("Audit log OK")
  })

  test("factory stop writes the kill switch", async () => {
    await run(["factory", "stop", "lunch"])
    expect(await Bun.file(factoryLayout(root).stop).text()).toContain("lunch")
  })
})

describe("mcp", () => {
  test("lists coarse tools without any human-only tool and calls them with an advisory agent", async () => {
    const server = createMcpServer({ root, stateDir: state })
    const init = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    })
    expect(init?.result.protocolVersion).toBe("2025-03-26")
    const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = list?.result.tools.map((tool: any) => tool.name)
    expect(names).toContain("complete")
    expect(names.some((name: string) => /approve|trust|waive|resume/.test(name) && name !== "request_approval")).toBe(
      false,
    )
    const status = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    })
    expect(status?.result.content[0].text).toContain("factory-state")
    const refused = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "complete", arguments: { agent: "es-qa-functional" } },
    })
    expect(refused?.result.isError).toBe(true)
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined()
  })

  test("serves newline-delimited JSON-RPC over stdio", async () => {
    const proc = Bun.spawn(["bun", path.join(import.meta.dir, "../src/main.ts"), "mcp", "--cwd", root], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ES_STATE_DIR: state },
    })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`)
    proc.stdin.end()
    const lines = (await new Response(proc.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.map((line) => line.id)).toEqual([1, 2])
    expect(lines[0].result.serverInfo.name).toBe("epistemic-swarm")
  })

  test("H1: a piped agent argument cannot claim a seat; identity is pinned to the adapter environment", async () => {
    const call = (server: ReturnType<typeof createMcpServer>, args: Record<string, unknown>) =>
      server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "complete", arguments: args } })
    // No adapter identity: the caller is "mcp", which holds no seat, so even
    // agent:"factory" is refused as mcp at the tool's own seat check.
    const bare = createMcpServer({ root, stateDir: state, env: {} })
    const spoofed = await call(bare, { agent: "factory" })
    expect(spoofed?.result.isError).toBe(true)
    expect(spoofed?.result.content[0].text).toContain("called by mcp")
    // The adapter pins one identity per server in its environment: that identity
    // reaches the tool (here refused as factory at the programmer-only check).
    const pinned = createMcpServer({ root, stateDir: state, env: { ES_MCP_AGENT: "factory" } })
    const admitted = await call(pinned, {})
    expect(admitted?.result.isError).toBe(true)
    expect(admitted?.result.content[0].text).toContain("called by factory")
    // The per-call argument is ignored: claiming factory under a QA pin stays refused as QA.
    const qaPinned = createMcpServer({ root, stateDir: state, env: { ES_MCP_AGENT: "es-qa-functional" } })
    const ignored = await call(qaPinned, { agent: "factory" })
    expect(ignored?.result.isError).toBe(true)
    expect(ignored?.result.content[0].text).toContain("called by es-qa-functional")
  })
})

describe("opencode driver", () => {
  test("runs opencode in the project: PWD is the project root, not the caller's directory", async () => {
    const { chmod, mkdtemp: mk } = await import("node:fs/promises")
    const { opencodeDriver } = await import("../src/headless.ts")
    const bin = await mk(path.join(tmpdir(), "es-fake-opencode-"))
    // A Bun stub reports the PWD it inherited verbatim (sh would recompute it).
    await writeFile(
      path.join(bin, "opencode"),
      `#!/usr/bin/env bun\nconsole.log(JSON.stringify({ type: "text", sessionID: "ses_fake1", part: { text: process.env.PWD } }))\n`,
    )
    await chmod(path.join(bin, "opencode"), 0o755)
    const previous = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previous}`
    try {
      const events: any[] = []
      const turn = opencodeDriver.turn({ root, agent: "factory", prompt: "go" })
      let step = await turn.next()
      while (!step.done) {
        events.push(step.value)
        step = await turn.next()
      }
      expect(events[0]?.part?.text).toBe(root)
      expect(step.value).toBe("ses_fake1")
    } finally {
      process.env.PATH = previous
      await rm(bin, { recursive: true, force: true })
    }
  })
})

describe("headless", () => {
  const collect = async (driver: HarnessDriver, maxTurns = 10) => {
    const events: any[] = []
    for await (const event of runHeadless({ root, driver, maxTurns, stallTurns: 2, stateDir: state }))
      events.push(event)
    return events
  }
  const driver = (onTurn: () => Promise<void>): HarnessDriver => ({
    id: "fake",
    available: async () => true,
    async *turn() {
      yield { text: "working" }
      await onTurn()
      return "ses_fake"
    },
  })

  test("stops for the grill, for pending approvals, and when progress stalls", async () => {
    expect((await collect(driver(async () => {}))).at(-1)).toMatchObject({ type: "error" })
    const factory = await grilledFrontier()
    expect((await collect(driver(async () => {}))).at(-1)).toMatchObject({ type: "waiting" })
    await mkdir(path.dirname(factoryLayout(root).pending), { recursive: true })
    await writeFile(factoryLayout(root).pending, JSON.stringify([{ stage: "spec", requestedBy: "factory", at: "x" }]))
    expect((await collect(driver(async () => {}))).at(-1)).toMatchObject({ type: "waiting", stages: ["spec"] })
    await writeFile(factoryLayout(root).pending, "[]")
    await run(["approve", "frontier"], human())
    expect((await factory.read())?.stage).toBe("RESEARCH")
    const stalled = await collect(driver(async () => {}))
    expect(stalled.filter((event) => event.type === "turn")).toHaveLength(2)
    expect(stalled.at(-1)).toMatchObject({ type: "stalled" })
  })

  test("a stall carries its evidence: the headline, last activity and running seats", async () => {
    await grilledFrontier()
    await run(["approve", "frontier"], human())
    const stalled = (await collect(driver(async () => {}))).at(-1) as any
    expect(stalled).toMatchObject({ type: "stalled", turns: 2, seats: [] })
    expect(stalled.headline).toStartWith("Research in progress")
    expect(typeof stalled.lastActivityAgoSec).toBe("number")
  })

  test("research artifacts count as progress: a run caching sources hits the turn cap, not a stall", async () => {
    await grilledFrontier()
    await run(["approve", "frontier"], human())
    const cache = new SourceCache(researchSourcesDir(root), state)
    let n = 0
    const events = await collect(
      driver(async () => {
        n++
        await cache.put({
          url: `https://example.test/${n}`,
          text: `Source number ${n} for the run.`,
          provider: "fetch",
        })
      }),
      4,
    )
    expect(events.filter((event) => event.type === "turn")).toHaveLength(4)
    expect(events.at(-1)).toEqual({ type: "turn-cap", turns: 4 })
  })

  test("a long turn reports progress while it runs; start names where to watch", async () => {
    await grilledFrontier()
    await run(["approve", "frontier"], human())
    const slow: HarnessDriver = {
      id: "slow",
      available: async () => true,
      async *turn() {
        await Bun.sleep(120)
        yield { type: "text", part: { text: "done fetching" } }
        return "ses_slow"
      },
    }
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({ root, driver: slow, maxTurns: 1, stateDir: state, progressMs: 30 }))
      events.push(event)
    expect(events[0]).toMatchObject({ type: "start", monitor: expect.stringContaining("es watch") })
    const progress = events.filter((event) => event.type === "progress")
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0]).toMatchObject({ headline: expect.stringContaining("Research"), seats: [] })
  })

  test("a failing turn ends with an error event and leaves no progress timer behind", async () => {
    await grilledFrontier()
    await run(["approve", "frontier"], human())
    const failing: HarnessDriver = {
      id: "failing",
      available: async () => true,
      // biome-ignore lint/correctness/useYield: the turn fails before producing anything
      async *turn() {
        throw new Error("opencode run exited 1")
      },
    }
    const started = Date.now()
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({ root, driver: failing, maxTurns: 1, stateDir: state, progressMs: 60_000 }))
      events.push(event)
    expect(events.at(-1)).toEqual({ type: "error", message: "opencode run exited 1" })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("reports a halt", async () => {
    const factory = await grilledFrontier()
    await run(["approve", "frontier"], human())
    const events = await collect(driver(() => factory.halt("system", "test halt").then(() => undefined)))
    expect(events.at(-1)).toMatchObject({ type: "halted", reason: "test halt" })
  })
})

describe("headless log levels (#59)", () => {
  const big = "x".repeat(5000)
  const toolUse = {
    type: "tool_use",
    part: { tool: "read", state: { status: "completed", input: { path: ".factory/frontier.json" }, output: big } },
  }

  test("info: one compact line per tool call and the text; steps are dropped", () => {
    expect(presentEvent({ type: "driver", event: toolUse }, "info")).toEqual({
      type: "tool",
      tool: "read",
      status: "completed",
      target: ".factory/frontier.json",
    })
    expect(presentEvent({ type: "driver", event: { type: "text", part: { text: "Merging." } } }, "info")).toEqual({
      type: "text",
      text: "Merging.",
    })
    expect(presentEvent({ type: "driver", event: { type: "step_finish", part: {} } }, "info")).toBeUndefined()
  })

  test("debug keeps the raw event with long strings clipped; quiet drops driver events, never lifecycle", () => {
    const shown = JSON.stringify(presentEvent({ type: "driver", event: toolUse }, "debug"))
    expect(shown).toContain(".factory/frontier.json")
    expect(shown).toContain("…[+2952 chars]")
    expect(shown.length).toBeLessThan(2500)
    expect(presentEvent({ type: "driver", event: toolUse }, "quiet")).toBeUndefined()
    expect(presentEvent({ type: "turn", n: 1, stage: "RESEARCH" }, "quiet")).toEqual({
      type: "turn",
      n: 1,
      stage: "RESEARCH",
    })
  })

  test("an unknown level is refused before anything runs", async () => {
    const result = await run(["factory", "run", "--headless", "--log-level", "all"])
    expect(result.code).toBe(2)
    expect(result.out).toContain("quiet, info, debug")
  })
})

describe("es audit and es scout (headless jobs)", () => {
  const AUTH = `export function login(db, user) {\n  const sql = "SELECT * FROM users WHERE name = '" + user + "'"\n  return db.query(sql)\n}\n`
  /** A fake harness turn that plays the seats through the core tools. */
  const seatDriver = (onTurn: (prompt: string) => Promise<void>): HarnessDriver => ({
    id: "fake",
    available: async () => true,
    async *turn({ prompt }) {
      yield { text: "working" }
      await onTurn(prompt)
      return "ses_fake"
    },
  })
  const core = () => import("@heretek-ai/es-core")

  test("--help has no side effects; no run and no ceiling is refused; creating a run needs a terminal", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.js"), AUTH)
    for (const argv of [
      ["audit", "src", "--help"],
      ["scout", "x", "--help"],
    ])
      expect((await run(argv)).code).toBe(0)
    expect(await exists(factoryLayout(root).dir)).toBe(false)
    const bare = await run(["audit", "src", "--open-only"])
    expect([bare.code, bare.out]).toEqual([2, expect.stringContaining("--max-usd <USD>")])
    expect((await run(["audit", "src", "--max-usd", "5", "--open-only"])).code).toBe(3)
    DRIVERS.fake = seatDriver(async () => {})
    try {
      expect((await run(["scout", "a parser", "--max-usd", "5", "--driver", "fake"])).code).toBe(3)
    } finally {
      delete DRIVERS.fake
    }
    expect(await exists(factoryLayout(root).state)).toBe(false)
  })

  test("an unavailable driver starts nothing: no run, no audit round", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.js"), AUTH)
    await run(["audit", "src", "--max-usd", "5", "--open-only"], human())
    DRIVERS.down = { id: "down", available: async () => false, async *turn() {} }
    try {
      const audit = await run(["audit", "src", "--driver", "down"])
      expect([audit.code, audit.out]).toEqual([2, expect.stringContaining("nothing was started")])
      expect((await run(["scout", "a parser", "--driver", "down"])).code).toBe(2)
    } finally {
      delete DRIVERS.down
    }
    expect((await run(["audit", "show", "audit-01"])).out).toContain("open (round 1)")
  })

  test("es audit opens on a run (provisioning its ceiling at a TTY), drives the pair, and reports the verdict", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    const { codeAuditTools, Factory } = await core()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.js"), AUTH)
    const opened = await run(["audit", "src", "--max-usd", "5", "--open-only"], human())
    expect([opened.code, opened.out]).toEqual([0, expect.stringContaining("Opened audit-01 (round 1) on path src.")])
    // Now the run has a ceiling: no terminal needed for the next round.
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    const verdict = codeAuditTools({ root, factory, stateDir: state }).find((tool) => tool.name === "es_audit_verdict")!
    const prompts: string[] = []
    DRIVERS.fake = seatDriver(async (prompt) => {
      prompts.push(prompt)
      // The thesis maps an invariant that holds; the red team found nothing.
      const mapped = {
        kind: "invariant",
        title: "Queries go through the db handle",
        severity: "info",
        file: "src/auth.js",
        lines: [3, 3],
        excerpt: "return db.query(sql)",
        detail: "All database access in this module uses the passed-in db handle.",
        holds: true,
      }
      await verdict.execute(
        { audit: "audit-01", verdict: "pass", findings: [mapped], notes: "ok" },
        { agent: "es-auditor-thesis" },
      )
      await verdict.execute(
        { audit: "audit-01", verdict: "pass", findings: [], notes: "tried injection, races, secrets" },
        { agent: "es-auditor-antithesis" },
      )
    })
    try {
      const driven = await run(["audit", "src", "--driver", "fake"])
      expect(driven.code).toBe(0)
      expect(driven.out).toContain("Opened audit-01 (round 2) on path src.")
      expect(driven.out).toContain("Audit audit-01 passed. Report: .factory/audits/audit-01/REPORT.md")
      expect(prompts[0]).toContain("Headless code audit audit-01 on path src")
    } finally {
      delete DRIVERS.fake
    }
    const shown = await run(["audit", "show"])
    expect(shown.out).toContain("audit-01 · path src · passed (round 2)")
  })

  test("es audit dismiss is human-only and unblocks", async () => {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.js"), AUTH)
    await run(["audit", "src", "--max-usd", "5", "--open-only"], human())
    expect((await run(["audit", "dismiss", "audit-01"], human())).code).toBe(2)
    expect((await run(["audit", "dismiss", "audit-01", "--reason", "vendored"])).code).toBe(3)
    expect((await run(["audit", "dismiss", "audit-01", "--reason", "vendored code we never ship"], human())).code).toBe(
      0,
    )
    expect((await run(["audit", "show", "audit-01"])).out).toContain("dismissed by human:")
  })

  test("es scout drives the scout seat until it completes and prints the ranked verdicts", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    const { scoutTools } = await core()
    await mkdir(path.join(root, "vendor/tiny"), { recursive: true })
    await writeFile(path.join(root, "vendor/tiny/index.js"), "module.exports = () => 1\n")
    await writeFile(path.join(root, "vendor/tiny/package.json"), '{"name":"tiny","version":"1.0.0"}')
    const tool = (name: string) => scoutTools({ root, stateDir: state }).find((item) => item.name === name)!
    DRIVERS.fake = seatDriver(async () => {
      const scout = { agent: "scout" }
      await tool("es_scout_plan").execute(
        { objective: "a tiny helper", candidates: [{ name: "tiny", source: "local:./vendor/tiny" }] },
        scout,
      )
      await tool("es_scout_scan").execute({ candidate: "tiny" }, scout)
      await tool("es_scout_record").execute(
        { candidate: "tiny", maintenance: "slow", proposal: "adopt", rationale: "small enough to keep", claims: [] },
        scout,
      )
      await tool("es_scout_complete").execute({}, scout)
    })
    try {
      const scouted = await run(["scout", "a tiny helper", "--max-usd", "3", "--driver", "fake"], human())
      expect(scouted.code).toBe(0)
      // No license file: adopt is downgraded by core, whatever the seat proposed.
      expect(scouted.out).toContain("1. tiny: clean-room")
      expect(scouted.out).toContain("Report: .factory/scout/REPORT.md. Adoption is your decision.")
    } finally {
      delete DRIVERS.fake
    }
    expect((await run(["scout", "show"])).out).toContain("1. tiny — unknown (unverified) — clean-room")
  })
})

describe("release version", () => {
  test("VERSION equals the package version, and every version surface uses it", async () => {
    const pkg = JSON.parse(await readFile(path.join(import.meta.dir, "..", "package.json"), "utf8")) as {
      version: string
    }
    expect(VERSION).toBe(pkg.version)
    expect((await run(["version"])).out).toBe(VERSION)
    // The MCP serverInfo fallback must be the same constant, not a stale literal.
    const source = await readFile(path.join(import.meta.dir, "..", "src", "mcp.ts"), "utf8")
    expect(source).toContain("options.version ?? VERSION")
  })
})

describe("status and runs (1.1.3)", () => {
  const begin = (at: string = root) =>
    new Factory(at, { gates: gateRunner({ stateDir: state }), stateDir: state }).begin("human:tester")

  test("es status without a run says how to start one", async () => {
    const result = await run(["status"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("No factory run in this project. Start one with /grill.")
  })

  test("es status leads with a plain headline and the run header naming the project", async () => {
    const begun = await begin()
    const result = await run(["status"])
    expect(result.code).toBe(0)
    const lines = result.out.split("\n")
    expect(lines[0]).toBe("The grill is running: answer its questions in the grill session.")
    expect(lines[1]).toStartWith(`run ${begun.runId} · GRILL · ${root} · updated `)
    expect(result.out).toContain("recent events:")
    expect(result.out).not.toContain("<factory-state>")
    expect((await run(["factory", "status"])).out).toBe(result.out)
  })

  test("es status --json carries the headline, liveness and summary block", async () => {
    await begin()
    const parsed = JSON.parse((await run(["status", "--json"])).out)
    expect(parsed.headline).toContain("The grill is running")
    expect(parsed.liveness.stage).toBe("GRILL")
    expect(parsed.liveness.root).toBe(root)
    expect(parsed.summary).toContain("<factory-state>")
  })

  test("es runs lists runs across projects; --run targets another project; the cwd is warned about a fresher run", async () => {
    const here = await begin()
    const other = await mkdtemp(path.join(tmpdir(), "es-cli-other-"))
    try {
      // The other project's run saves a moment later, so it is the more recently active one.
      await Bun.sleep(5)
      const there = await begin(other)
      const runs = await run(["runs"])
      expect(runs.out.split("\n")[0]).toContain(there.runId)
      expect(runs.out).toContain(`* ${here.runId}`)
      expect(runs.out).toContain(other)

      const status = await run(["status"])
      expect(status.out).toContain(`Note: a more recently active run is ${there.runId} (GRILL) in ${other}`)
      expect(status.out).toContain(`es status --run ${there.runId}`)

      const targeted = await run(["status", "--run", there.runId])
      expect(targeted.out.split("\n")[1]).toStartWith(`run ${there.runId} · GRILL · ${other}`)
      expect(targeted.out).not.toContain("Note: a more recently active run")

      const unknown = await run(["status", "--run", "run-20990101-000000-ffff"])
      expect(unknown.code).toBe(2)
      expect(unknown.out).toContain("es runs")
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  test("es watch needs a terminal, redraws es status until q, and validates --interval", async () => {
    const refused = await run(["watch"])
    expect(refused.code).toBe(2)
    expect(refused.out).toContain("es watch needs a terminal")

    await begin()
    const frames: string[] = []
    let press: ((key: string) => void) | undefined
    const terminal = {
      interactive: true,
      write: (text: string) => {
        frames.push(text)
        if (frames.length === 2) press?.("q")
      },
      onKey: (listener: (key: string) => void) => {
        press = listener
        return () => {
          press = undefined
        }
      },
    }
    const watch = (argv: string[]) =>
      main(argv, { print: () => {}, confirm: pipe, cwd: root, stateDir: state, terminal })
    expect(await watch(["watch", "--interval", "0.2"])).toBe(0)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toStartWith("\x1b[2J\x1b[H")
    expect(frames[0]).toContain("The grill is running")
    expect(frames[0]).toContain("q quit · refreshes every 0.2s")
    // The key listener is released on exit.
    expect(press).toBeUndefined()
    expect(await watch(["watch", "--interval", "0"])).toBe(2)
  })

  test("es runs hides finished runs unless --all, and says so when there are none", async () => {
    expect((await run(["runs"])).out).toContain("No active runs")
    expect((await run(["runs", "--all"])).out).toContain("No indexed runs")
    const begun = await begin()
    expect(JSON.parse((await run(["runs", "--json"])).out)[0].runId).toBe(begun.runId)
  })
})

describe("headless fleet (#120)", () => {
  const toolDriver = (onTurn?: () => Promise<void>): HarnessDriver => ({
    id: "fake",
    available: async () => true,
    async *turn() {
      yield { type: "tool_use", part: { tool: "read", state: { status: "completed", input: { path: "src/a.ts" } } } }
      yield { type: "tool_use", part: { tool: "edit", state: { status: "failed", input: {}, error: "nope" } } }
      yield { type: "text", part: { text: "working" } }
      await onTurn?.()
      return "ses_fake"
    },
  })

  test("the JSONL stream is versioned and schema-validated for every event kind", async () => {
    const { HeadlessJsonlSchema, toJsonl } = await import("../src/headless.ts")
    const samples: HeadlessEvent[] = [
      { type: "start", runId: "run-1", stage: "RESEARCH", driver: "fake", monitor: "m" },
      { type: "turn", n: 1, stage: "RESEARCH" },
      { type: "driver", event: { text: "x" } },
      { type: "progress", headline: "h", seats: [] },
      { type: "turn-metrics", turn: 1, costUSD: 0, tools: [] },
      { type: "waiting", reason: "r" },
      { type: "halted", reason: "r" },
      { type: "stalled", turns: 3, headline: "h", seats: [] },
      { type: "turn-cap", turns: 4 },
      { type: "cancelled", reason: "r" },
      { type: "done" },
      { type: "error", message: "m" },
    ]
    for (const event of samples) {
      const envelope = toJsonl("run-1", event)
      expect(envelope.v).toBe(1)
      expect(envelope.kind).toBe(event.type)
      expect(HeadlessJsonlSchema.safeParse(envelope).success).toBe(true)
    }
    expect(
      HeadlessJsonlSchema.safeParse({ v: 2, at: new Date().toISOString(), runId: "r", kind: "x", event: {} }).success,
    ).toBe(false)
  })

  test("each turn emits turn-metrics with tool activity and the sealed spend delta", async () => {
    await grilledFrontier()
    await run(["approve", "frontier"], human())
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    let n = 0
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver: toolDriver(async () => {
        n++
        if (n === 1) await factory.recordSpend(0.05, false)
      }),
      maxTurns: 2,
      stallTurns: 99,
      stateDir: state,
      progressMs: 60_000,
    }))
      events.push(event)
    const metrics = events.filter((event) => event.type === "turn-metrics")
    expect(metrics).toHaveLength(2)
    expect(metrics[0]).toMatchObject({
      type: "turn-metrics",
      turn: 1,
      tools: [
        { name: "read", ok: true },
        { name: "edit", ok: false },
      ],
    })
    expect((metrics[0] as any).costUSD).toBeCloseTo(0.05, 5)
    expect(metrics[1]).toMatchObject({ type: "turn-metrics", turn: 2, costUSD: 0 })
  })

  test("an aborted run emits cancelled, writes no halt, and resumes", async () => {
    await grilledFrontier()
    await run(["approve", "frontier"], human())
    const hanging: HarnessDriver = {
      id: "hang",
      available: async () => true,
      async *turn() {
        // A handle-free hang: no timer, so abandoning the turn ends the test.
        await new Promise<never>(() => {})
        yield { text: "never" }
        return undefined
      },
    }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver: hanging,
      maxTurns: 5,
      stateDir: state,
      signal: controller.signal,
      progressMs: 60_000,
    }))
      events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "cancelled" })
    expect(events.some((event) => event.type === "error")).toBe(false)
    // No halt written, no STOP file: the run is resumable.
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    expect((await factory.read())?.stage).toBe("RESEARCH")
    expect(await exists(factoryLayout(root).stop)).toBe(false)
    const resumed: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver: toolDriver(),
      maxTurns: 1,
      stallTurns: 99,
      stateDir: state,
      progressMs: 60_000,
    }))
      resumed.push(event)
    expect(resumed[0]).toMatchObject({ type: "start" })
  })

  test("a turn past --turn-timeout ends as a turn-timeout error", async () => {
    await grilledFrontier()
    await run(["approve", "frontier"], human())
    const hanging: HarnessDriver = {
      id: "hang",
      available: async () => true,
      async *turn() {
        // A handle-free hang: no timer, so abandoning the turn ends the test.
        await new Promise<never>(() => {})
        yield { text: "never" }
        return undefined
      },
    }
    const events: HeadlessEvent[] = []
    for await (const event of runHeadless({
      root,
      driver: hanging,
      maxTurns: 5,
      stateDir: state,
      turnTimeoutMs: 120,
      progressMs: 60_000,
    }))
      events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("turn-timeout") })
  })

  test("headless exit codes: cancelled is 130, failures stay 1, the rest 0", async () => {
    const { headlessExitCode } = await import("../src/headless.ts")
    expect(headlessExitCode("cancelled")).toBe(130)
    for (const type of ["error", "halted", "stalled", "turn-cap"] as const) expect(headlessExitCode(type)).toBe(1)
    for (const type of ["start", "turn", "driver", "progress", "turn-metrics", "waiting", "done"] as const)
      expect(headlessExitCode(type)).toBe(0)
  })

  test("--cwd refuses seat worktrees of active runs and detached HEADs", async () => {
    const { checkCwd } = await import("../src/headless.ts")
    // A plain project root is fine (and so is a non-repo dir).
    expect(await checkCwd(root)).toBeUndefined()
    // Inside another active run's .factory/worktrees: refused.
    const proj = await mkdtemp(path.join(tmpdir(), "es-cwd-proj-"))
    try {
      await mkdir(path.join(proj, ".factory", "worktrees", "seat-1"), { recursive: true })
      await mkdir(path.join(proj, ".factory", "runtime"), { recursive: true })
      await writeFile(path.join(proj, ".factory", "runtime", "state.json"), "{}")
      const refusal = await checkCwd(path.join(proj, ".factory", "worktrees", "seat-1"))
      expect(refusal).toContain(".factory/worktrees")
      // Without a run state it is not an active run: allowed.
      await rm(path.join(proj, ".factory", "runtime", "state.json"))
      expect(await checkCwd(path.join(proj, ".factory", "worktrees", "seat-1"))).toBeUndefined()
    } finally {
      await rm(proj, { recursive: true, force: true })
    }
    // A detached-HEAD worktree is refused; attached is fine.
    const wt = await mkdtemp(path.join(tmpdir(), "es-cwd-wt-"))
    try {
      const proc = Bun.spawn(["git", "worktree", "add", "--detach", wt], { cwd: root, stdout: "pipe", stderr: "pipe" })
      await proc.exited
      expect(await checkCwd(wt)).toContain("branch")
      const proc2 = Bun.spawn(["git", "-C", wt, "checkout", "-q", "-b", "wt-branch"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc2.exited
      expect(await checkCwd(wt)).toBeUndefined()
    } finally {
      const proc = Bun.spawn(["git", "worktree", "remove", "--force", wt], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      await rm(wt, { recursive: true, force: true })
    }
  })

  test("--events jsonl prints one envelope per line; --events-file redirects it", async () => {
    const { HeadlessJsonlSchema } = await import("../src/headless.ts")
    // No run here: a single error envelope on stdout.
    const streamed = await run(["factory", "run", "--headless", "--events", "jsonl"])
    expect(streamed.code).toBe(1)
    const lines = streamed.out.split("\n").filter((line) => line.trim())
    expect(lines).toHaveLength(1)
    const parsed = HeadlessJsonlSchema.safeParse(JSON.parse(lines[0]!))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.kind).toBe("error")
    expect(await run(["factory", "run", "--headless", "--events", "yaml"])).toMatchObject({ code: 2 })
    // --events-file: the envelope goes to the file, stdout keeps human lines.
    const file = path.join(root, "events.jsonl")
    const filed = await run(["factory", "run", "--headless", "--events", "jsonl", "--events-file", file])
    expect(filed.code).toBe(1)
    expect(filed.out.trim()).not.toStartWith("{")
    const saved = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim())
    expect(saved).toHaveLength(1)
    expect(HeadlessJsonlSchema.safeParse(JSON.parse(saved[0]!)).success).toBe(true)
  })

  test("--turn-timeout validates its value before anything runs", async () => {
    expect((await run(["factory", "run", "--headless", "--turn-timeout", "soon"])).code).toBe(2)
    expect((await run(["factory", "run", "--headless", "--turn-timeout", "0"])).code).toBe(2)
  })
})
