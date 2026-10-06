import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  controlClass,
  evaluateRead,
  evaluateShell,
  evaluateWrite,
  rebaseline,
  verifyControl,
} from "../src/trust/index.ts"

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
    ["opencode.jsonc", "config"],
    [".claude/settings.json", "config"],
    [".factory/specs/p1/GOAL.md", undefined],
    ["src/index.ts", undefined],
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

  test("human-only CLIs are denied for every agent", () => {
    expect(shell("build", "es approve spec").effect).toBe("deny")
    expect(shell(undefined, "cd x && epistemic-swarm waive lint/check").effect).toBe("deny")
  })

  test("mutating control files from the shell is denied; seats may not mention them at all", () => {
    expect(shell("build", "echo {} > .factory/approvals/spec.json").effect).toBe("deny")
    expect(shell("build", "cat .factory/gates.json").effect).toBe("allow")
    expect(shell("es-programmer", "cat .factory/gates.json").effect).toBe("deny")
  })

  test("read-only seats run sandboxed, or allowlisted when bubblewrap is missing", () => {
    expect(shell("es-qa-functional", "bun test")).toEqual({ effect: "allow", mode: "readonly-sandbox" })
    expect(shell("es-qa-functional", "git diff | head", false)).toEqual({ effect: "allow", mode: "readonly-checked" })
    expect(shell("es-qa-functional", "rm -rf src", false).effect).toBe("deny")
    expect(shell("es-qa-functional", "cat $(echo x)", false).effect).toBe("deny")
  })

  test("seats cannot push or rewrite refs", () => {
    expect(shell("es-programmer", "git push origin HEAD").effect).toBe("deny")
    expect(shell("es-programmer", "bun test")).toEqual({ effect: "allow", mode: "normal" })
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
})
