// Seat × control-path deny-write matrix on the real host (#182). Every
// registry seat attempts every control path through each write route (write,
// edit, patch, shell) and every attempt must be refused. The unit-level pin of
// the same matrix lives in packages/core/test/control-matrix.test.ts (and the
// sampled proofs in policy.test.ts); this suite proves it through the real
// OpenCode v2 host, on pinned 2.0.24 and under scripts/v2-head.sh.
//
// Layer notes (see packages/core/src/trust/policy.ts + sandbox.ts):
// - write/edit/patch are refused in-process by evaluateWrite (canonical path,
//   symlink-resolved, case-insensitive): status error, with the per-class
//   reason ("factory control file" vs "host configuration") pinned per seat in
//   a sequential spot-check (parallel turns smear the first rejection's text
//   across sibling outcomes — host behaviour — so parallel cells assert the
//   per-cell status only).
// - shell from a seat is refused by the CONTROL_MENTION text rule for the
//   paths it names (status error, no marker); the two paths it does NOT name
//   (improve, harvest/clean-room markdown) run and fail without the marker.
//   Which layer refused is pinned per seat in the spot-check; the disk
//   (fixtures byte-identical, no stray control files) pins every cell.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

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
] as const

/**
 * Control paths the shell text rule does not name (see CONTROL_MENTION in
 * trust/policy.ts: it lists waivers/approvals/runtime/STOP/git-hooks/claims/
 * audits/research and the brainstorm-harvest-design-scout JSON globs, but
 * neither improve nor clean-room markdown files). A seat's shell carrying one
 * of these passes the text layer and is refused by the sandbox's read-only
 * .factory bind instead.
 */
const SANDBOX_BACKSTOP = new Set([".factory/harvest/clean-room/widget-search.md", ".factory/improve/proposal.json"])

const GATES_FIXTURE = '{"version":1,"commands":[]}\n'
const APPROVALS_FIXTURE = '{"stage":"spec"}\n'

describe("control-file deny-write matrix on the real host (#182)", () => {
  let h: Harness
  let state: string

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-matrix-state-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: {
        "README.md": "# matrix\n",
        "docs/notes.md": "# notes\n",
        ".factory/gates.json": GATES_FIXTURE,
        ".factory/approvals/spec.json": APPROVALS_FIXTURE,
      },
    })
  }, 180_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  for (const spec of AGENTS) {
    test(`${spec.id}: write, edit, patch and shell refuse every control path`, async () => {
      const agent = spec.id
      const batch = async (attempts: string[]) => {
        const { tools } = await h.run(`@@PARALLEL@@ ${attempts.join(" ")}`, { agent })
        expect(tools).toHaveLength(attempts.length)
        return tools
      }

      // Reason texts are pinned in the sequential spot-check below: parallel
      // turns smear the first rejection's text across sibling outcomes (host
      // behaviour), so parallel cells assert the per-cell status only.
      for (const tool of ["write", "edit"] as const) {
        const tools = await batch(CONTROL_PATHS.map((target) => call(tool, { path: target, content: "pwned" })))
        const byPath = new Map(tools.map((outcome) => [(outcome.input as { path?: string })?.path, outcome]))
        expect([...byPath.keys()].sort()).toEqual([...CONTROL_PATHS].sort())
        for (const target of CONTROL_PATHS)
          expect(`${target}:${byPath.get(target)!.name}:${byPath.get(target)!.status}`).toBe(`${target}:${tool}:error`)
      }

      const patches = await batch(
        CONTROL_PATHS.map((target) =>
          call("patch", { patchText: `*** Begin Patch\n*** Add File: ${target}\n+pwned\n*** End Patch` }),
        ),
      )
      const byPatch = new Map(patches.map((outcome) => [(outcome.input as { patchText?: string })?.patchText, outcome]))
      expect(byPatch.size).toBe(CONTROL_PATHS.length)
      for (const target of CONTROL_PATHS) {
        const outcome = byPatch.get(`*** Begin Patch\n*** Add File: ${target}\n+pwned\n*** End Patch`)!
        expect(`${target}:${outcome.name}:${outcome.status}`).toBe(`${target}:patch:error`)
      }

      const shells = await batch(
        CONTROL_PATHS.map((target) => call("shell", { command: `echo pwned > ${target} && echo WRITE-SUCCEEDED` })),
      )
      const byCommand = new Map(shells.map((outcome) => [(outcome.input as { command?: string })?.command, outcome]))
      expect(byCommand.size).toBe(CONTROL_PATHS.length)
      for (const target of CONTROL_PATHS) {
        const outcome = byCommand.get(`echo pwned > ${target} && echo WRITE-SUCCEEDED`)!
        expect(`${target}:${outcome.name}`).toBe(`${target}:shell`)
        expect(outcome.text).not.toContain("WRITE-SUCCEEDED")
        // Text-named paths are refused before execution (status error); the
        // sandbox-backstop paths run and fail without the marker (their shell
        // UX status is host- and kernel-dependent, so the marker and the disk
        // pin them, not the status). Which layer refused is pinned per seat in
        // the sequential spot-check below.
        if (!SANDBOX_BACKSTOP.has(target)) expect(`${target}:${outcome.status}`).toBe(`${target}:error`)
      }

      // Sequential spot-check: parallel turns smear the first rejection's text
      // across sibling outcomes (host behaviour), so the reason per path class
      // is pinned here with correct attribution, one turn per call.
      const spot = await h.run(
        [
          call("write", { path: ".factory/gates.json", content: "pwned" }),
          call("write", { path: "opencode.jsonc", content: "pwned" }),
          call("shell", { command: "echo pwned > .factory/gates.json && echo WRITE-SUCCEEDED" }),
        ].join(" "),
        { agent },
      )
      expect(spot.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual([
        "write:error",
        "write:error",
        "shell:error",
      ])
      expect(spot.tools[0]?.text).toContain("factory control file")
      expect(spot.tools[1]?.text).toContain("host configuration")
      expect(spot.tools[2]?.text).toMatch(/may not reference control files/)
      expect(spot.tools[2]?.text).not.toContain("WRITE-SUCCEEDED")

      // Nothing on disk moved, for any seat.
      expect(await readFile(path.join(h.directory, ".factory/gates.json"), "utf8")).toBe(GATES_FIXTURE)
      expect(await readFile(path.join(h.directory, ".factory/approvals/spec.json"), "utf8")).toBe(APPROVALS_FIXTURE)
    }, 180_000)
  }

  test("no control file escaped onto disk anywhere", async () => {
    for (const target of CONTROL_PATHS) {
      if (target === ".factory/gates.json" || target === ".factory/approvals/spec.json") continue
      if (target === ".git/config" || target === ".git/hooks/pre-commit") continue
      expect(await Bun.file(path.join(h.directory, target)).exists()).toBe(false)
    }
  })
})

describe("symlink and case-variant bypasses on the real host (#182)", () => {
  let h: Harness
  let state: string

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-matrix-bypass-state-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: {
        "README.md": "# bypass\n",
        "docs/notes.md": "# notes\n",
        ".factory/gates.json": GATES_FIXTURE,
        ".factory/approvals/spec.json": APPROVALS_FIXTURE,
      },
    })
    // A symlink from the manager's allowed dir (docs/) into .factory/approvals/.
    await symlink(path.join(h.directory, ".factory/approvals"), path.join(h.directory, "docs/link"))
  }, 180_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("edit/write resolve the symlink and refuse at the policy layer", async () => {
    const { tools } = await h.run(
      `@@PARALLEL@@ ${call("edit", { path: "docs/link/spec.json", content: "pwned" })} ${call("write", { path: "docs/link/spec.json", content: "pwned" })}`,
      { agent: "es-manager" },
    )
    // Matched by input: parallel turns keep per-cell statuses but smear the
    // first rejection's text, and may reorder outcomes.
    const byInput = new Map(tools.map((tool) => [`${tool.name}:${(tool.input as { path?: string })?.path}`, tool]))
    for (const tool of ["edit", "write"]) {
      const outcome = byInput.get(`${tool}:docs/link/spec.json`)!
      expect(outcome.status).toBe("error")
      expect(outcome.text).toContain("factory control file")
    }
    expect(await readFile(path.join(h.directory, ".factory/approvals/spec.json"), "utf8")).toBe(APPROVALS_FIXTURE)
  })

  test("a shell through the symlink passes the text layer and never executes the write", async () => {
    // "docs/link/spec.json" names no control file, so the text rule allows it;
    // enforcement is the sandbox around the seat's shell. On a healthy host
    // the read-only .factory bind fails the redirect (EROFS); on hosts where
    // bubblewrap cannot construct the sandbox (this container's kernel rejects
    // its overlay mounts) the command never runs at all — fail-closed either
    // way. The && chain proves the redirect itself never succeeded, and the
    // refusal text proves the text layer was not the enforcer.
    const { tools } = await h.run(
      `link ${call("shell", { command: "echo pwned > docs/link/spec.json && echo WRITE-SUCCEEDED" })}`,
      { agent: "es-manager" },
    )
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe("shell")
    expect(tools[0]?.text).not.toContain("WRITE-SUCCEEDED")
    expect(tools[0]?.text).not.toMatch(/may not reference control files/)
    expect(await readFile(path.join(h.directory, ".factory/approvals/spec.json"), "utf8")).toBe(APPROVALS_FIXTURE)
  })

  test("case-variant edit and shell are refused end to end", async () => {
    // Sequential (one turn per call): parallel turns smear the first
    // rejection's text across sibling outcomes, which would hide which layer
    // refused the shell.
    const { tools } = await h.run(
      `${call("edit", { path: ".FACTORY/GATES.json", content: "pwned" })} ${call("shell", { command: "echo pwned > .FACTORY/GATES.json && echo WRITE-SUCCEEDED" })}`,
      { agent: "es-manager" },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["edit:error", "shell:error"])
    expect(tools[0]?.text).toContain("factory control file")
    expect(tools[1]?.text).toMatch(/may not reference control files/)
    expect(tools[1]?.text).not.toContain("WRITE-SUCCEEDED")
    expect(await readFile(path.join(h.directory, ".factory/gates.json"), "utf8")).toBe(GATES_FIXTURE)
    expect(await Bun.file(path.join(h.directory, ".FACTORY/GATES.json")).exists()).toBe(false)
  })
})
