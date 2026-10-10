// STOP kill-switch delete-denial (#184, bug #229): `.factory/STOP` is a
// factory control file, so no agent can create, overwrite or remove it
// through any surface. Host `write`/`edit` and every `patch` target funnel
// through evaluateWrite (packages/opencode/src/policy.ts maps patch targets
// through it too); `shell` goes through evaluateShell. This closes the proof
// gap without changing product behaviour.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { controlClass } from "../src/trust/control.ts"
import { evaluateShell, evaluateWrite } from "../src/trust/index.ts"

// Pure classification: fixed paths, no filesystem needed (as in control.test.ts).
const ctx = () => ({ root: "/tmp/es-stop-delete-test", stateDir: "/tmp/es-stop-delete-state" })
const effect = (decision: { effect: string }) => decision.effect

describe("STOP is a factory control file", () => {
  test("STOP classifies as factory control, however cased or nested", () => {
    for (const file of [".factory/STOP", ".FACTORY/STOP", ".factory/stop", ".factory/worktrees/p1/.factory/STOP"])
      expect([file, controlClass(file)]).toEqual([file, "factory"])
    // A suffixed name is not the kill-switch.
    expect(controlClass(".factory/STOP.bak")).toBeUndefined()
  })
})

describe("STOP write policy", () => {
  test("no agent writes STOP: relative, absolute and dot-dot paths are denied", () => {
    const root = "/tmp/es-stop-delete-test"
    for (const agent of [
      undefined,
      "build",
      "factory",
      "es-manager",
      "es-programmer",
      "es-qa-functional",
      "es-research-alpha",
      "harvester",
    ])
      for (const target of [".factory/STOP", path.join(root, ".factory/STOP"), "docs/../.factory/STOP"])
        expect([agent, target, effect(evaluateWrite(ctx(), agent, target))]).toEqual([agent, target, "deny"])
  })
})

describe("STOP shell policy", () => {
  const shell = (agent: string | undefined, command: string) =>
    evaluateShell(ctx(), agent, command, { sandboxAvailable: true })

  test("no agent mutates STOP from the shell, however wrapped", () => {
    for (const command of [
      "echo hold > .factory/STOP",
      "rm .factory/STOP",
      "rm -f .factory/STOP",
      `python3 -c 'open(".factory/STOP","w").write("hold")'`,
      "echo hold > .FACTORY/STOP",
      "echo hold > docs/../.factory/STOP",
    ])
      for (const agent of ["build", "factory", "es-programmer"])
        expect([agent, command, shell(agent, command).effect]).toEqual([agent, command, "deny"])
    // #37 shapes (as for gates.json in policy.test.ts): cd-relative and
    // separator variants, denied for the user's agents.
    for (const command of [
      "cd .factory && echo hold > STOP",
      "cd .factory;echo hold > STOP",
      "cd .factory&&echo hold > STOP",
      "cd .factory|tee STOP",
    ])
      expect([command, shell("build", command).effect]).toEqual([command, "deny"])
  })

  test("seats may not even mention STOP; user reads stay allowed (gates parity)", () => {
    for (const agent of ["factory", "es-programmer", "es-qa-functional"])
      expect([agent, shell(agent, "cat .factory/STOP").effect]).toEqual([agent, "deny"])
    expect(shell("build", "cat .factory/STOP").effect).toBe("allow")
    expect(shell("build", "ls .factory").effect).toBe("allow")
  })
})
