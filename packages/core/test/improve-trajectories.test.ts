// Synthetic trajectory harvester for local model distillation (#175):
// passed + verified phase worktrees become scrubbed, diff-verified SFT/DPO
// datasets. Fail-closed: unverified worktrees, missing transcripts and
// secret-bearing output are refused or skipped with recorded reasons —
// never exported silently.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  exportDataset,
  harvestTrajectories,
  scrubSecretsText,
  type Trajectory,
  TrajectoryError,
} from "../src/improve/trajectories.ts"

// Test-only fake secrets, built by interpolation (repo precedent:
// `ghp_${"..."}") so static scanners never see a credential-like literal.
// Runtime values stay realistic so the scrubber gets a true workout.
const GH_TOKEN = `ghp_${"harvestTest001AAAABBBBCCCCDDDDEEEEFFFF"}`
const SK = `sk-ant-${"harvestTest0000AAAAAAAAAAAAAAAAAAAA"}`
const AKIA = `AKIA${"IOSFODNN7EXAMPLE"}`
const PASSWORD = `hunter2-${"secret"}`
const BEARER = `eyJhbGciOiJIUzI1NiJ9.${"payload"}.${"sig"}`
const KEY_BEGIN = `-----BEGIN PRIVATE ${"KEY-----"}`
const KEY_END = `-----END PRIVATE ${"KEY-----"}`

const transcript = [
  { role: "user", content: "Fix the unused variable in src/x.ts." },
  { role: "assistant", content: "I will delete everything.", failed: true },
  { role: "tool", content: "gate lint red: src/x.ts still has unused vars" },
  { role: "assistant", content: "Removed the unused import; gates green." },
].map((line) => JSON.stringify(line))

const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1 +1 @@",
  "-import { unused } from './y';",
  "+export const x = 1;",
  "",
].join("\n")

const verified = () => ({ gatesGreen: true, auditValid: true })

describe("scrubSecretsText", () => {
  test("redacts token families and private keys, counting redactions", () => {
    const input = [
      `token ${GH_TOKEN}`,
      `key ${SK}`,
      AKIA,
      `password = "${PASSWORD}"`,
      KEY_BEGIN,
      "aGVsbG8td29ybGQta2V5LWJvZHk=",
      KEY_END,
      `Authorization: Bearer ${BEARER}`,
    ].join("\n")
    const { text, redactions } = scrubSecretsText(input)
    expect(text).not.toContain(GH_TOKEN)
    expect(text).not.toContain(SK)
    expect(text).not.toContain(AKIA)
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain("PRIVATE")
    expect(redactions).toBeGreaterThanOrEqual(5)
  })

  test("leaves ordinary prose untouched", () => {
    const { text, redactions } = scrubSecretsText("Removed the unused import; gates green.")
    expect(text).toBe("Removed the unused import; gates green.")
    expect(redactions).toBe(0)
  })
})

describe("harvestTrajectories", () => {
  test("harvests a verified worktree into a scrubbed, diff-verified trajectory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-traj-"))
    const { trajectories, skipped } = await harvestTrajectories({
      worktrees: [{ dir, phaseId: "phase-1", verification: verified() }],
      readTranscript: async () => transcript.join("\n"),
      readDiff: async () => DIFF,
    })
    expect(skipped).toEqual([])
    expect(trajectories).toHaveLength(1)
    expect(trajectories[0]!.turns).toHaveLength(4)
    expect(trajectories[0]!.verified).toBe(true)
    expect(trajectories[0]!.codeDiff).toBe(DIFF)
    await rm(dir, { recursive: true, force: true })
  })

  test("fail-closed: unverified worktrees are skipped with reasons, never harvested", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-traj-unverified-"))
    const { trajectories, skipped } = await harvestTrajectories({
      worktrees: [
        { dir, phaseId: "phase-1", verification: { gatesGreen: false, auditValid: true } },
        { dir, phaseId: "phase-2", verification: { gatesGreen: true, auditValid: false } },
      ],
      readTranscript: async () => transcript.join("\n"),
      readDiff: async () => DIFF,
    })
    expect(trajectories).toEqual([])
    expect(skipped).toHaveLength(2)
    expect(skipped.every((entry) => entry.reason.length > 0)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("fail-closed: missing transcripts and empty diffs are skipped, not exported", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-traj-empty-"))
    const missing = await harvestTrajectories({
      worktrees: [{ dir, verification: verified() }],
      readTranscript: async () => "",
      readDiff: async () => DIFF,
    })
    expect(missing.trajectories).toEqual([])
    expect(missing.skipped[0]!.reason).toMatch(/transcript/)
    const empty = await harvestTrajectories({
      worktrees: [{ dir, verification: verified() }],
      readTranscript: async () => transcript.join("\n"),
      readDiff: async () => "",
    })
    expect(empty.trajectories).toEqual([])
    expect(empty.skipped[0]!.reason).toMatch(/diff/)
    await rm(dir, { recursive: true, force: true })
  })

  test("fail-closed: escaping diff paths are refused", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-traj-escape-"))
    const evil = "diff --git a/x b/x\n--- a/x\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n"
    const { trajectories, skipped } = await harvestTrajectories({
      worktrees: [{ dir, verification: verified() }],
      readTranscript: async () => transcript.join("\n"),
      readDiff: async () => evil,
    })
    expect(trajectories).toEqual([])
    expect(skipped[0]!.reason).toMatch(/escape|path/i)
    await rm(dir, { recursive: true, force: true })
  })

  test("secrets in transcripts are scrubbed before they reach the trajectory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-traj-secret-"))
    const dirty = [{ role: "user", content: `Use token ${GH_TOKEN} to fetch.` }]
      .map((line) => JSON.stringify(line))
      .join("\n")
    const { trajectories } = await harvestTrajectories({
      worktrees: [{ dir, verification: verified() }],
      readTranscript: async () => dirty,
      readDiff: async () => DIFF,
    })
    expect(trajectories).toHaveLength(1)
    const harvested = [
      trajectories[0]!.codeDiff,
      trajectories[0]!.gateFeedback,
      ...trajectories[0]!.turns.map((turn) => turn.content),
    ].join("\n")
    expect(harvested).not.toContain(GH_TOKEN)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("exportDataset", () => {
  const trajectoryOf = (turns: Array<{ role: string; content: string; failed?: boolean }>): Trajectory => ({
    id: "traj-1",
    worktree: "/tmp/wt",
    phaseId: "phase-1",
    verified: true,
    turns: turns.map((turn) => ({
      role: turn.role as "user" | "assistant" | "tool",
      content: turn.content,
      ...(turn.failed ? { failed: true as const } : {}),
    })),
    codeDiff: DIFF,
    gateFeedback: "gates green",
    scrubRedactions: 0,
  })

  test("SFT export writes Unsloth/Axolotl-compatible chat JSONL plus a manifest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-sft-"))
    const out = path.join(dir, "sft.jsonl")
    const trajectories = [
      trajectoryOf([
        { role: "user", content: "Fix x." },
        { role: "assistant", content: "Fixed x." },
      ]),
    ]
    const result = await exportDataset(trajectories, { format: "jsonl", kind: "sft", output: out })
    expect(result.records).toBe(1)
    const lines = (await readFile(out, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!)
    expect(record.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"])
    const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"))
    expect(manifest).toMatchObject({ format: "jsonl", kind: "sft", records: 1 })
    await rm(dir, { recursive: true, force: true })
  })

  test("DPO export pairs the final answer with the earliest failed attempt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-dpo-"))
    const out = path.join(dir, "dpo.jsonl")
    const trajectories = [
      trajectoryOf([
        { role: "user", content: "Fix x." },
        { role: "assistant", content: "Delete everything.", failed: true },
        { role: "assistant", content: "Removed the unused import." },
      ]),
    ]
    const result = await exportDataset(trajectories, { format: "jsonl", kind: "dpo", output: out })
    expect(result.records).toBe(1)
    const record = JSON.parse((await readFile(out, "utf8")).trim().split("\n")[0]!)
    expect(record.prompt).toContain("Fix x.")
    expect(record.chosen).toContain("unused import")
    expect(record.rejected).toContain("Delete everything.")
    await rm(dir, { recursive: true, force: true })
  })

  test("fail-closed: DPO without a failed attempt is skipped, and unknown formats throw", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-dpo-skip-"))
    const trajectories = [trajectoryOf([{ role: "user", content: "Hi." }])]
    const result = await exportDataset(trajectories, {
      format: "jsonl",
      kind: "dpo",
      output: path.join(dir, "dpo.jsonl"),
    })
    expect(result.records).toBe(0)
    expect(result.skipped).toHaveLength(1)
    await expect(
      exportDataset(trajectories, { format: "parquet", kind: "sft", output: path.join(dir, "x") }),
    ).rejects.toThrow(TrajectoryError)
    await rm(dir, { recursive: true, force: true })
  })
})
