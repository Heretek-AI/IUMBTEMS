// Audit proofs for #338 (trajectory harvester): a scrub corpus across token
// families, PEM blocks, URLs with credentials and env files leaves nothing
// behind, and escaping diff paths are skipped with reasons.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exportDataset, harvestTrajectories, scrubSecretsText } from "../src/improve/trajectories.ts"

// Test-only fake secrets, built by interpolation so static scanners never see
// a credential-like literal. Runtime values stay realistic.
const GH = `ghp_${"auditScrub001AAAABBBBCCCCDDDDEEEEFFFF"}`
const ANTHROPIC = `sk-ant-${"auditScrub0000AAAAAAAAAAAAAAAAAAAA"}`
const OPENAI_PROJ = `${"sk-proj-"}${"auditScrub00112233445566778899aabbcc"}`
const AWS = `AKIA${"IOSFODNN7EXAMPLE"}`
const SLACK = `${"xoxb-"}${"1234-audit-scrub-token"}`
const BEARER_VALUE = `eyJhbGciOiJIUzI1NiJ9.${"auditpayload"}.${"auditsig"}`
const KEY_BEGIN = `-----BEGIN PRIVATE ${"KEY-----"}`
const KEY_END = `-----END PRIVATE ${"KEY-----"}`
const URL_PG = `postgres://bob:${"hunter2-secret"}@db.example.com:5432/app`
const URL_HTTPS = `https://alice:${"s3cr3t-pw"}@github.com/org/repo.git`
const ENV_AWS_SECRET = `wJalrXUtnFEMI/K7MDENG/bPxRfiCYSECRETKEY`
const JWT = `${"eyJhbGciOiJIUzI1NiJ9"}.${"cGF5bG9hZA"}.${"c2lnbmF0dXJl"}`

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

describe("audit #338: scrub corpus leaves nothing behind", () => {
  test("tokens, PEM blocks, URLs with credentials and env secrets are all redacted", () => {
    const corpus = [
      `token ${GH}`,
      `key ${ANTHROPIC}`,
      `openai ${OPENAI_PROJ}`,
      AWS,
      `slack ${SLACK}`,
      `Authorization: Bearer ${BEARER_VALUE}`,
      `jwt ${JWT}`,
      `${"password"} = "${"hunter2-secret"}"`,
      KEY_BEGIN,
      "aGVsbG8td29ybGQta2V5LWJvZHk=",
      KEY_END,
      `db ${URL_PG}`,
      `remote ${URL_HTTPS}`,
      `GITHUB_TOKEN=${GH}`,
      `AWS_SECRET_ACCESS_KEY=${ENV_AWS_SECRET}`,
      `DATABASE_URL=${URL_PG}`,
    ].join("\n")
    const { text, redactions } = scrubSecretsText(corpus)
    expect(text).not.toContain(GH)
    expect(text).not.toContain(ANTHROPIC)
    expect(text).not.toContain(OPENAI_PROJ)
    expect(text).not.toContain(AWS)
    expect(text).not.toContain(SLACK)
    expect(text).not.toContain(BEARER_VALUE)
    expect(text).not.toContain(JWT)
    expect(text).not.toContain("hunter2-secret")
    expect(text).not.toContain("s3cr3t-pw")
    expect(text).not.toContain(ENV_AWS_SECRET)
    expect(text).not.toContain("PRIVATE")
    expect(redactions).toBeGreaterThanOrEqual(8)
  })

  test("planted secrets do not survive harvest or export", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-audit-scrub-"))
    const dirty = [
      { role: "user", content: `Use token ${GH} with db ${URL_PG}.` },
      { role: "assistant", content: `Key ${ANTHROPIC} failed.`, failed: true },
      { role: "assistant", content: `Done. Env GITHUB_TOKEN=${GH} cleaned.` },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")
    const { trajectories, skipped } = await harvestTrajectories({
      worktrees: [{ dir, phaseId: "phase-1", verification: verified() }],
      readTranscript: async () => dirty,
      readDiff: async () => `notes ${GH}\n${DIFF}`,
    })
    expect(skipped).toEqual([])
    expect(trajectories).toHaveLength(1)
    const harvested = [
      trajectories[0]!.codeDiff,
      trajectories[0]!.gateFeedback,
      ...trajectories[0]!.turns.map((t) => t.content),
    ].join("\n")
    expect(harvested).not.toContain(GH)
    expect(harvested).not.toContain(ANTHROPIC)
    expect(harvested).not.toContain("hunter2-secret")

    const out = path.join(dir, "sft.jsonl")
    const result = await exportDataset(trajectories, { format: "jsonl", kind: "sft", output: out })
    expect(result.records).toBe(1)
    const exported = await readFile(out, "utf8")
    expect(exported).not.toContain(GH)
    expect(exported).not.toContain(ANTHROPIC)
    const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"))
    expect(manifest.records).toBe(1)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("audit #338: escaping paths are skipped with reasons", () => {
  test("diff paths escaping the workspace are skipped and named", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-audit-escape-"))
    const transcript = [{ role: "user", content: "Fix x." }].map((l) => JSON.stringify(l)).join("\n")
    const evil = "diff --git a/x b/x\n--- a/x\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n"
    const { trajectories, skipped } = await harvestTrajectories({
      worktrees: [{ dir, phaseId: "phase-1", verification: verified() }],
      readTranscript: async () => transcript,
      readDiff: async () => evil,
    })
    expect(trajectories).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.worktree).toBe(dir)
    expect(skipped[0]!.reason).toMatch(/escape|path/i)
    await rm(dir, { recursive: true, force: true })
  })

  test("export skips are named in the manifest with reasons", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-audit-manifest-"))
    // No failed attempt: DPO export must skip, never invent a negative.
    const trajectory = {
      id: "traj-1",
      worktree: path.join(dir, "wt"),
      verified: true as const,
      turns: [{ role: "user" as const, content: "Hi." }],
      codeDiff: DIFF,
      gateFeedback: "gates green",
      scrubRedactions: 0,
    }
    const out = path.join(dir, "dpo.jsonl")
    const result = await exportDataset([trajectory], { format: "jsonl", kind: "dpo", output: out })
    expect(result.records).toBe(0)
    expect(result.skipped).toHaveLength(1)
    const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"))
    expect(manifest.records).toBe(0)
    expect(manifest.skipped).toHaveLength(1)
    expect(manifest.skipped[0].worktree).toBe(trajectory.worktree)
    expect(manifest.skipped[0].reason.length).toBeGreaterThan(0)
    await rm(dir, { recursive: true, force: true })
  })
})
