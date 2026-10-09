// Self-dogfood preset (#137): the factory builds this repo. Preset files
// validate against their schemas, init seeds the run with the release base
// pinned to `rewrite`, and the PR argv never names `main`.
import { describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildPrArgs,
  EsConfigSchema,
  factoryLayout,
  GatesConfigSchema,
  initFromPreset,
  invokesHumanOnly,
  KNOWN_PRESETS,
  presetsDir,
  RoadmapSchema,
  readPreset,
  SELF_DOGFOOD_BASE_BRANCH,
} from "../src/index.ts"

describe("self-dogfood preset files", () => {
  test("the preset is known and its control files validate", async () => {
    expect(KNOWN_PRESETS).toContain("self-dogfood")
    const preset = await readPreset("self-dogfood")
    const config = EsConfigSchema.parse(JSON.parse(preset.config))
    expect(config.audit?.phase).toBe("required")
    expect(config.pr).toBe("gh")
    const gates = GatesConfigSchema.parse(JSON.parse(preset.gates))
    expect(gates.commands.map((command) => command.command)).toEqual([
      "bun install --frozen-lockfile",
      "bun run check",
      "bun run docs:check",
    ])
  })

  test("unknown presets are refused", async () => {
    await expect(readPreset("no-such-preset")).rejects.toThrow('unknown preset "no-such-preset"')
  })

  test("the idea-from-issue helper exists and is executable", async () => {
    const script = path.join(presetsDir(), "self-dogfood", "idea-from-issue.sh")
    await access(script)
    const proc = Bun.spawn(["sh", "-n", script], { stdout: "pipe", stderr: "pipe" })
    expect(await proc.exited).toBe(0)
  })
})

describe("initFromPreset", () => {
  test("seeds control files, a rewrite-based roadmap and the issue idea", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-preset-"))
    try {
      const { written, baseBranch } = await initFromPreset(root, "self-dogfood", {
        issue: 137,
        title: "Self-dogfood preset",
        body: "The factory builds this repo.",
      })
      expect(baseBranch).toBe("rewrite")
      expect(written).toEqual([
        ".factory/config.json",
        ".factory/gates.json",
        ".factory/roadmap.json",
        ".factory/notes/idea-137.md",
      ])
      const layout = factoryLayout(root)
      expect(RoadmapSchema.parse(JSON.parse(await readFile(layout.roadmap, "utf8"))).baseBranch).toBe("rewrite")
      expect(GatesConfigSchema.parse(JSON.parse(await readFile(layout.gates, "utf8"))).commands).toHaveLength(3)
      expect(await readFile(path.join(root, ".factory/notes/idea-137.md"), "utf8")).toContain(
        "# #137: Self-dogfood preset",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("self-dogfood PR base", () => {
  test("the draft PR targets rewrite, never main", () => {
    expect(SELF_DOGFOOD_BASE_BRANCH).toBe("rewrite")
    const argv = buildPrArgs({ branch: "factory/x/integration", base: "rewrite", title: "t", body: "b" })
    expect(argv).toContain("--draft")
    expect(argv.slice(argv.indexOf("--base") + 1, argv.indexOf("--base") + 2)).toEqual(["rewrite"])
    expect(argv).not.toContain("main")
  })
})

describe("factory init is human-only", () => {
  test("agents are refused the init verb", () => {
    expect(invokesHumanOnly("es factory init --preset self-dogfood --issue 137")).toBe(true)
    expect(invokesHumanOnly("es factory begin")).toBe(false)
  })
})

describe("initFromPreset control hygiene (S2.1)", () => {
  test("a prior baseline stays clean and the audit log records the preset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-preset-hygiene-"))
    try {
      const { rebaseline, verifyControl } = await import("../src/index.ts")
      const { recentAuditEntries } = await import("../src/index.ts")
      const { readJson } = await import("../src/index.ts")
      await rebaseline(root, "human:earlier")
      await initFromPreset(
        root,
        "self-dogfood",
        { issue: 137, title: "Self-dogfood preset", body: "The factory builds this repo." },
        { actor: "human:tester" },
      )
      const check = await verifyControl(root)
      expect(check.violations).toEqual([])
      expect(check.clean).toBe(true)
      const entries = await recentAuditEntries(root, 5)
      const last = entries.at(-1)!
      expect(last.action).toBe("factory.preset")
      expect(last.actor).toBe("human:tester")
      expect(last.payload).toMatchObject({ preset: "self-dogfood", issue: 137 })
      const baseline = await readJson<{ updatedBy: string }>(factoryLayout(root).control)
      expect(baseline?.updatedBy).toContain("human:tester")
      expect(baseline?.updatedBy).toContain("self-dogfood")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("writes hold the per-file lock (no writes past a held lock)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-preset-lock-"))
    try {
      const { withLock, writeJson } = await import("../src/index.ts")
      const layout = factoryLayout(root)
      await writeJson(layout.config, { sentinel: true })
      let intactWhileLocked = false
      let started: Promise<unknown> | undefined
      await withLock(layout.config, async () => {
        started = initFromPreset(
          root,
          "self-dogfood",
          { issue: 137, title: "Self-dogfood preset", body: "The factory builds this repo." },
          { actor: "human:tester" },
        )
        await Bun.sleep(150)
        intactWhileLocked =
          (JSON.parse(await readFile(layout.config, "utf8")) as { sentinel?: boolean }).sentinel === true
      })
      await started!
      expect(intactWhileLocked).toBe(true)
      expect(GatesConfigSchema.parse(JSON.parse(await readFile(layout.gates, "utf8"))).commands).toHaveLength(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("preset-seeded runs pin the release base (S2.2)", () => {
  test("the opener builds its argv through one exported function", async () => {
    const core = (await import("../src/index.ts")) as unknown as {
      buildPrArgs?: (options: {
        branch: string
        base: string
        title: string
        body: string
        preset?: string
      }) => string[]
      selfDogfoodPrArgs?: unknown
    }
    expect(typeof core.buildPrArgs).toBe("function")
    expect(core.selfDogfoodPrArgs).toBeUndefined()
    const argv = core.buildPrArgs!({ branch: "factory/x/integration", base: "rewrite", title: "t", body: "b" })
    expect(argv.slice(0, 4)).toEqual(["gh", "pr", "create", "--draft"])
    expect(argv.slice(argv.indexOf("--base") + 1, argv.indexOf("--base") + 2)).toEqual(["rewrite"])
    expect(argv).not.toContain("main")
  })

  test("the shared argv refuses --base main for a preset run", async () => {
    const { buildPrArgs } = (await import("../src/index.ts")) as unknown as {
      buildPrArgs: (options: { branch: string; base: string; title: string; body: string; preset?: string }) => string[]
    }
    expect(() =>
      buildPrArgs({ branch: "factory/x/integration", base: "main", title: "t", body: "b", preset: "self-dogfood" }),
    ).toThrow(/refusing.*main/)
    expect(() =>
      buildPrArgs({ branch: "factory/x/integration", base: "other", title: "t", body: "b", preset: "self-dogfood" }),
    ).toThrow(/rewrite/)
  })
})

describe("a preset-seeded run end to end (S2.2)", () => {
  const PASSPHRASE = "test-passphrase-151-s2"
  const green = { passed: true, findings: [] as never[], summary: "green" }

  const seedAndReachSpec = async (options: { keepBaseBranch: boolean }) => {
    const { gitRepo, frontier, writeReport, writeSpecs } = await import("./helpers.ts")
    const { Factory, recordApproval, sealHumanKey, unlockHumanKey } = await import("../src/index.ts")
    const fx = await gitRepo("es-preset-e2e-")
    await Bun.spawn(["git", "branch", "rewrite"], { cwd: fx.root }).exited
    await sealHumanKey(PASSPHRASE, fx.state)
    const signer = await unlockHumanKey(PASSPHRASE, fx.state)
    await initFromPreset(
      fx.root,
      "self-dogfood",
      { issue: 137, title: "Self-dogfood preset", body: "The factory builds this repo." },
      { actor: "human:tester" },
    )
    const opened: Array<{ branch: string; base: string; title: string; body: string; preset?: string }> = []
    const factory = new Factory(fx.root, {
      gates: async () => green,
      pr: {
        id: "fake",
        available: async () => true,
        open: async (request) => {
          opened.push(request as { branch: string; base: string; title: string; body: string; preset?: string })
          return { url: `https://example.test/pr/${opened.length}` }
        },
      },
      stateDir: fx.state,
    })
    const begun = await factory.begin("human:tester")
    const { writeFrontier } = factory
    await factory.writeFrontier("grill", frontier())
    await recordApproval(fx.root, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
    await factory.beginResearch("human:tester")
    await writeReport(fx.root, fx.state)
    await factory.completeResearch("factory")
    await writeSpecs(fx.root, ["dogfood"])
    if (options.keepBaseBranch) {
      // The grill kept baseBranch when it rewrote the roadmap (before approval).
      const roadmapFile = factoryLayout(fx.root).roadmap
      const roadmap = JSON.parse(await readFile(roadmapFile, "utf8"))
      await Bun.write(roadmapFile, `${JSON.stringify({ ...roadmap, baseBranch: "rewrite" }, null, 2)}\n`)
    }
    await recordApproval(fx.root, { stage: "spec", channel: "cli", approvedBy: "tester", signer })
    return { fx, factory, opened, begun, writeFrontier }
  }

  test("a preset-seeded run releases its draft PR on rewrite", async () => {
    const { fx, factory, opened } = await seedAndReachSpec({ keepBaseBranch: true })
    try {
      const { buildPrArgs } = (await import("../src/index.ts")) as unknown as {
        buildPrArgs: (options: {
          branch: string
          base: string
          title: string
          body: string
          preset?: string
        }) => string[]
      }
      const built = await factory.startBuild("factory")
      expect(built.baseBranch).toBe("rewrite")
      const dir = (await factory.activeWorktree())!
      await mkdir(path.join(dir, "test"), { recursive: true })
      await mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "test/dogfood.test.ts"), 'test("dogfood", () => {})\n')
      await factory.recordGateRun("es-programmer", {
        passed: false,
        findings: [],
        summary: "red",
        failedTests: ["test/dogfood.test.ts"],
      })
      await Bun.write(path.join(dir, "src/dogfood.ts"), "export const dogfood = 1\n")
      expect((await factory.complete("es-programmer")).ok).toBe(true)
      await factory.qaVerdict("es-qa-functional", "pass", "criteria met")
      await factory.qaVerdict("es-qa-adversarial", "pass", "nothing broke")
      const done = await factory.release("factory")
      expect(done.stage).toBe("DONE")
      expect(opened).toHaveLength(1)
      expect(opened[0]?.base).toBe("rewrite")
      expect(opened[0]?.preset).toBe("self-dogfood")
      const argv = buildPrArgs({ ...opened[0]! })
      expect(argv).toContain("--draft")
      expect(argv.slice(argv.indexOf("--base") + 1, argv.indexOf("--base") + 2)).toEqual(["rewrite"])
      expect(argv).not.toContain("main")
    } finally {
      await fx.cleanup()
    }
  })

  test("a roadmap rewrite that drops baseBranch halts the preset run", async () => {
    const { fx, factory } = await seedAndReachSpec({ keepBaseBranch: false })
    try {
      // writeSpecs left a roadmap with no baseBranch: the grill dropped it.
      const roadmap = JSON.parse(await readFile(factoryLayout(fx.root).roadmap, "utf8"))
      expect(roadmap.baseBranch).toBeUndefined()
      await expect(factory.startBuild("factory")).rejects.toThrow(/baseBranch/)
      const state = await factory.read()
      expect(state?.baseBranch ?? "rewrite").toBe("rewrite")
    } finally {
      await fx.cleanup()
    }
  })
})
