// Issue #180 integration tests (opencode surface): every agent-reachable
// approval path is refused on the real v2 host, while the human TUI path
// signs in-process with channel "tui" and five wrong passphrases lock out.
// Real in-process host via @heretek-ai/es-testkit (scripted fake LLM);
// must pass on pinned 2.0.24 and under scripts/v2-head.sh.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  checkApprovalAttempts,
  Factory,
  factoryLayout,
  gateRunner,
  pendingApprovals,
  readApproval,
  recentAuditEntries,
  sealHumanKey,
  verifyApproval,
  verifyRecordSignature,
  writeJson,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { approveInTui } from "../src/approve-tui.ts"
import { EsRpc } from "../src/rpc-def.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const PASSPHRASE = "test-passphrase-1234"

let h: Harness
let state: string

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-180-state-"))
  await sealHumanKey(PASSPHRASE, state)
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# approval 180\n" },
  })
  const factory = new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
  await factory.writeFrontier("grill", {
    version: "1.1",
    idea: "approval 180 probe",
    spendCeiling: { currency: "USD", maxAmount: 5 },
    settled: true,
    nodes: [{ id: "a", question: "q?", answer: "yes", status: "settled" }],
  })
  await writeJson(factoryLayout(h.directory).pending, [
    { stage: "frontier", requestedBy: "factory", at: new Date().toISOString() },
  ])
}, 120_000)

afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("issue #180: no agent path grants an approval on the real host", () => {
  test("tool call, shell approval verbs and direct writes are all refused and record nothing", async () => {
    const target = path.join(h.directory, ".factory/approvals/frontier.json")
    const attempts = [
      call("es_approve", { stage: "frontier" }),
      call("shell", { command: "es approve frontier" }),
      call("shell", { command: "es approve spec" }),
      call("write", { path: ".factory/approvals/frontier.json", content: "{}" }),
      call("write", { path: target, content: "{}" }),
      call("patch", {
        patchText: "*** Begin Patch\n*** Add File: .factory/approvals/frontier.json\n+{}\n*** End Patch",
      }),
      call("shell", { command: "echo {} > .factory/approvals/frontier.json" }),
    ]
    const { tools } = await h.run(`approve by any path ${attempts.join(" ")}`)
    expect(tools).toHaveLength(attempts.length)
    for (const outcome of tools) expect(`${outcome.name}:${outcome.status}`).toBe(`${outcome.name}:error`)
    // The human-only shell verb says so; the control-file write says so.
    expect(tools[1]?.text).toMatch(/human-only/i)
    expect(tools[3]?.text).toMatch(/control file/i)
    // No approval tool is even advertised to the model.
    const advertised = h.llm.requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.function.name))
    expect(advertised).not.toContain("es_approve")
    // Nothing recorded: no record, no file, pending still waits for the human.
    expect(await readApproval(h.directory, "frontier")).toBeUndefined()
    expect(await Bun.file(target).exists()).toBe(false)
    expect((await pendingApprovals(h.directory)).map((item) => item.stage)).toContain("frontier")
  }, 120_000)

  test("no approve/trust/resume RPC exists; preview is read-only with a hash-bound ticket", async () => {
    const rpc = (h.opencode as any).rpc(EsRpc) as any
    for (const method of ["approve", "trust", "resume"]) expect(typeof rpc[method]).not.toBe("function")
    const preview = await rpc.previewApproval({ stage: "frontier" }, { location: h.location })
    expect(preview.ok).toBe(true)
    expect(preview.subjectHash).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof preview.token).toBe("string")
    // The validate-only redeem signs nothing: a bad token refuses.
    await expect(
      rpc.redeemApproval(
        { stage: "frontier", token: "no-such-token", subjectHash: preview.subjectHash },
        { location: h.location },
      ),
    ).rejects.toThrow()
    expect(await readApproval(h.directory, "frontier")).toBeUndefined()
  }, 60_000)
})

describe("issue #180: the TUI path signs in-process with channel tui", () => {
  test("preview over RPC + scripted masked dialog + redeem over RPC records a valid signed approval", async () => {
    const rpc = (h.opencode as any).rpc(EsRpc) as any
    const where = { location: h.location }
    const preview = await rpc.previewApproval({ stage: "frontier" }, where)
    expect(preview.ok).toBe(true)
    const outcome = await approveInTui({
      root: h.directory,
      stage: "frontier",
      expectedSubjectHash: preview.subjectHash,
      ...(preview.token ? { previewToken: preview.token as string } : {}),
      ...(preview.issuedAt !== undefined ? { previewIssuedAt: preview.issuedAt as number } : {}),
      redeemPreview: async (token) => {
        await rpc.redeemApproval({ stage: "frontier", token, subjectHash: preview.subjectHash }, where)
      },
      stateDir: state,
      readPassphrase: async () => [...PASSPHRASE],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record).toMatchObject({ stage: "frontier", channel: "tui" })
    expect(outcome.record.signature.alg).toBe("ed25519")
    const stored = await readApproval(h.directory, "frontier")
    expect(stored?.channel).toBe("tui")
    expect(stored?.signature.sig).toBe(outcome.record.signature.sig)
    expect(await verifyRecordSignature(outcome.record, state)).toBe(true)
    expect(await verifyApproval(h.directory, "frontier", { stateDir: state })).toMatchObject({ ok: true })
    expect(await pendingApprovals(h.directory)).toEqual([])
    const factory = new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
    expect((await factory.read())?.stage).toBe("RESEARCH")
    expect((await recentAuditEntries(h.directory, 10)).map((entry) => entry.action)).toContain("approval.frontier")
    // The passphrase reaches no persisted surface.
    const attempts = await readFile(path.join(state, "approval-attempts.json"), "utf8").catch(() => "[]")
    expect(attempts).not.toContain(PASSPHRASE.slice(4))
    expect(JSON.stringify(outcome.record)).not.toContain(PASSPHRASE.slice(4))
  }, 120_000)
})

describe("issue #180: five wrong passphrases then a correct one locks out", () => {
  test("the sixth attempt never prompts; the lockout is audited with channel tui", async () => {
    const before = await readApproval(h.directory, "frontier")
    let reads = 0
    const locked = await approveInTui({
      root: h.directory,
      stage: "frontier",
      expectedSubjectHash: "0".repeat(64),
      stateDir: state,
      readPassphrase: async () => {
        reads++
        return [..."wrong-passphrase-000"]
      },
    })
    expect(reads).toBe(5)
    expect(locked).toMatchObject({ ok: false, locked: true })
    expect((await checkApprovalAttempts(state)).allowed).toBe(false)
    // Even the correct passphrase is refused while locked: the dialog never opens.
    let correctReads = 0
    const stillLocked = await approveInTui({
      root: h.directory,
      stage: "frontier",
      expectedSubjectHash: "0".repeat(64),
      stateDir: state,
      readPassphrase: async () => {
        correctReads++
        return [...PASSPHRASE]
      },
    })
    expect(correctReads).toBe(0)
    expect(stillLocked).toMatchObject({ ok: false, locked: true })
    const lockout = (await recentAuditEntries(h.directory, 10)).find((entry) => entry.action === "approval.lockout")
    expect(lockout?.payload).toMatchObject({ stage: "frontier", channel: "tui" })
    // The lockout recorded nothing new: the frontier record is unchanged, spec never approved.
    expect(await readApproval(h.directory, "frontier")).toEqual(before)
    expect(await readApproval(h.directory, "spec")).toBeUndefined()
  }, 120_000)
})

describe("issue #180: the masked dialog shows no passphrase (bug #222 context)", () => {
  test("production MaskedInput frames contain bullets but never the probe", async () => {
    const proc = Bun.spawn(
      ["bun", "--conditions=browser", "--preload", "@opentui/solid/preload", "test/render/masked-180.tsx"],
      { cwd: pluginDir, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      frames: string[]
      delivered: string
      probe: string
    }
    expect(result.delivered).toBe(result.probe)
    expect(result.frames.length).toBeGreaterThan(0)
    for (const frame of result.frames) expect(frame).not.toContain(result.probe)
    expect(result.frames.some((frame) => frame.includes("•"))).toBe(true)
  }, 60_000)
})
