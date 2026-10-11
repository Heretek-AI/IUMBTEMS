// STOP kill-switch denials (#229): the kill-switch file itself is a control
// file, so no agent may delete or overwrite it — through the editor, the
// shell, or inside the sandbox (where .factory/ is read-only for every kind).
// Mirrors the gates/approvals shapes in policy.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { evaluateShell, evaluateWrite } from "../src/trust/index.ts"
import { type SandboxKind, sandboxArgv } from "../src/trust/sandbox.ts"

let root: string
let state: string
let worktree: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-stop-"))
  state = await mkdtemp(path.join(tmpdir(), "es-stop-state-"))
  worktree = path.join(root, ".factory/worktrees/p1")
  await mkdir(path.join(worktree, "src"), { recursive: true })
  await mkdir(path.join(root, ".factory/approvals"), { recursive: true })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const ctx = () => ({ root, worktree, stateDir: state })
const effect = (decision: { effect: string }) => decision.effect
const shell = (agent: string | undefined, command: string) =>
  evaluateShell(ctx(), agent, command, { sandboxAvailable: false })

describe("STOP kill-switch", () => {
  test("write-deny: no agent deletes or overwrites the kill-switch, by any path shape", () => {
    for (const agent of [undefined, "build", "factory", "es-programmer", "es-manager", "qa", "es-qa-functional"]) {
      expect([agent, effect(evaluateWrite(ctx(), agent, ".factory/STOP"))]).toEqual([agent, "deny"])
      expect(effect(evaluateWrite(ctx(), agent, path.join(root, ".factory/STOP")))).toBe("deny")
      expect(effect(evaluateWrite(ctx(), agent, "docs/../.factory/STOP"))).toBe("deny")
    }
  })

  test("shell-deny: removing or redirecting over the kill-switch is refused; seats may not mention it at all", () => {
    for (const command of ["rm .factory/STOP", "rm -f .factory/STOP", "echo x > .factory/STOP"])
      expect([command, shell("build", command).effect]).toEqual([command, "deny"])
    // Reads stay allowed for the user's own agents, as for other control files.
    expect(shell("build", "cat .factory/STOP").effect).toBe("allow")
    // Seats get no STOP handle at all: mentioning it is refused even to read.
    for (const command of ["rm .factory/STOP", "echo x > .factory/STOP", "cat .factory/STOP"])
      expect([command, shell("es-programmer", command).effect]).toEqual([command, "deny"])
  })

  test("sandbox-argv: .factory/ is read-only for every sandbox kind, so no shell inside can remove STOP", () => {
    const probe = { exists: () => true, overlay: false, uid: 1000 }
    for (const kind of ["user", "seat", "programmer", "readonly", "gate"] as const satisfies SandboxKind[]) {
      const args = sandboxArgv(
        {
          kind,
          root: "/p",
          cwd: "/p",
          stateDir: "/s",
          home: "/h",
          ...(["programmer", "gate"].includes(kind) ? { writable: "/p/.factory/worktrees/p1" } : {}),
        },
        ["true"],
        probe,
      )
      expect([kind, args.join(" ")]).toEqual([kind, expect.stringContaining("--ro-bind /p/.factory /p/.factory")])
    }
  })
})
