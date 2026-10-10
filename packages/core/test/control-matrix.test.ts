// Full seat × control-path enumeration at the unit level (#182). The sampled
// proofs live in policy.test.ts; this suite pins EVERY registry seat against
// every control glob (relative, absolute and dot-dot spellings), plus the
// shell layer split: seats are refused by the CONTROL_MENTION text rule
// except the two paths it does not name, which pass to the sandbox backstop.
// The same matrix runs against the real host in
// packages/opencode/test/control-matrix.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS } from "../src/agents/registry.ts"
import { evaluateShell, evaluateWrite } from "../src/trust/index.ts"

/** One representative per FACTORY_CONTROL / CONFIG_CONTROL glob (trust/control.ts). */
const CONTROL_PATHS = [
  ".factory/gates.json",
  ".factory/config.json",
  ".factory/frontier.json",
  ".factory/approvals/spec.json",
  ".factory/waivers/lint.json",
  ".factory/runtime/state.json",
  ".factory/STOP",
  ".factory/git-hooks/pre-commit",
  ".factory/brainstorm/scores.json",
  ".factory/brainstorm/runs/grill-1/ideas.json",
  ".factory/harvest/plan.json",
  ".factory/harvest/runs/grill-1/plan.json",
  ".factory/harvest/widget/profile.json",
  ".factory/harvest/clean-room/widget-search.md",
  ".factory/design/tokens.json",
  ".factory/design/components/button/tokens.json",
  `.factory/research/sources/${"a".repeat(64)}.md`,
  ".factory/research/coverage.json",
  ".factory/research/dossier.json",
  ".factory/research/brief.pcrb.json",
  ".factory/claims/retractions.json",
  ".factory/improve/proposal.json",
  ".factory/audits/audit-01.json",
  ".factory/scout/plan.json",
  ".factory/scout/widget/profile.json",
  ".factory/worktrees/phase-01/.factory/approvals/spec.json",
  ".git/config",
  ".git/hooks/pre-commit",
  "opencode.jsonc",
  ".claude/settings.json",
]

const FACTORY_PATHS = CONTROL_PATHS.filter(
  (target) => target !== "opencode.jsonc" && target !== ".claude/settings.json",
)

/** Paths the shell text rule does not name; seats pass them to the sandbox. */
const SANDBOX_BACKSTOP = new Set([".factory/harvest/clean-room/widget-search.md", ".factory/improve/proposal.json"])

let root: string
let state: string
let worktree: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-matrix-core-"))
  state = await mkdtemp(path.join(tmpdir(), "es-matrix-core-state-"))
  worktree = path.join(root, ".factory/worktrees/p1")
  await mkdir(path.join(root, ".factory/approvals"), { recursive: true })
  await mkdir(path.join(root, "src"), { recursive: true })
  await mkdir(path.join(worktree, "src"), { recursive: true })
  await writeFile(path.join(root, ".factory/approvals/spec.json"), "{}\n")
  await symlink(path.join(root, ".factory/approvals"), path.join(root, "src/link"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const ctx = () => ({ root, worktree, stateDir: state })

describe("control matrix: every seat is denied every control path (#182)", () => {
  test("evaluateWrite denies all seats, however the path is spelled", () => {
    for (const spec of AGENTS) {
      for (const target of CONTROL_PATHS) {
        for (const spelling of [target, path.join(root, target), `docs/../${target}`]) {
          const decision = evaluateWrite(ctx(), spec.id, spelling)
          expect([spec.id, spelling, decision.effect]).toEqual([spec.id, spelling, "deny"])
        }
      }
    }
  })

  test("non-seat agents are denied the factory controls but keep host semantics for config", () => {
    for (const agent of [undefined, "build"]) {
      for (const target of FACTORY_PATHS)
        expect([agent, target, evaluateWrite(ctx(), agent, target).effect]).toEqual([agent, target, "deny"])
      // Config controls ask the human for non-seat agents (host semantics).
      for (const target of ["opencode.jsonc", ".claude/settings.json"])
        expect([agent, target, evaluateWrite(ctx(), agent, target).effect]).toEqual([agent, target, "ask"])
    }
  })

  test("shell: seats are refused at the text layer except the documented sandbox-backstop paths", () => {
    for (const spec of AGENTS) {
      for (const target of CONTROL_PATHS) {
        const decision = evaluateShell(ctx(), spec.id, `echo pwned > ${target} && echo WRITE-SUCCEEDED`, {
          sandboxAvailable: true,
        })
        if (SANDBOX_BACKSTOP.has(target)) {
          // Not named by CONTROL_MENTION: runs under the sandbox, whose
          // read-only .factory bind refuses the redirect.
          expect([spec.id, target, decision]).toMatchObject([spec.id, target, { effect: "allow", mode: "sandbox" }])
        } else {
          expect(decision.effect).toBe("deny")
          expect("reason" in decision ? decision.reason : "").toMatch(/may not reference control files/)
        }
      }
    }
  })

  test("shell: non-seat agents are denied every control path (broad factory-dir rule)", () => {
    for (const target of CONTROL_PATHS) {
      const decision = evaluateShell(ctx(), undefined, `echo pwned > ${target}`, { sandboxAvailable: false })
      expect([target, decision.effect]).toEqual([target, "deny"])
    }
  })

  test("case variants are denied in the editor and the shell", () => {
    const variants = [
      ".FACTORY/GATES.json",
      ".factory/GATES.JSON",
      ".Factory/Approvals/Spec.JSON",
      ".GIT/CONFIG",
      "OpenCode.JSONC",
      ".CLAUDE/Settings.JSON",
    ]
    for (const spec of ["es-manager", "factory", "es-programmer", "es-qa-functional"]) {
      for (const target of variants) {
        expect([spec, target, evaluateWrite(ctx(), spec, target).effect]).toEqual([spec, target, "deny"])
        const shell = evaluateShell(ctx(), spec, `echo pwned > ${target}`, { sandboxAvailable: true })
        expect([spec, target, shell.effect]).toEqual([spec, target, "deny"])
      }
    }
  })

  test("a symlink from an allowed dir into .factory cannot be used to write a control file", () => {
    for (const spec of ["es-manager", "factory", "build", undefined]) {
      for (const target of ["src/link/spec.json", path.join(root, "src/link/spec.json")]) {
        const decision = evaluateWrite(ctx(), spec, target)
        expect([spec, target, decision.effect]).toEqual([spec, target, "deny"])
        expect("reason" in decision ? decision.reason : "").toContain("factory control file")
      }
    }
  })
})
