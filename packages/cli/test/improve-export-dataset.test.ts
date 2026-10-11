// `es improve export-dataset` (#175) through the CLI: a verified worktree
// (green gate summary + valid audit chain + transcript + git diff) exports
// SFT/DPO JSONL with a manifest; unverified worktrees are skipped with
// reasons, never exported.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { appendAuditEntry } from "@heretek-ai/es-core"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }

let root: string

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const printed: string[] = []
  const code = await main(argv, {
    print: (text) => printed.push(text),
    confirm: pipe,
    cwd: root,
    stateDir: path.join(root, ".es-state"),
  })
  return { code, out: printed.join("\n") }
}

/** A git worktree with a transcript, a green gate summary and a valid audit chain. */
async function makeVerifiedWorktree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "es-export-wt-"))
  const proc = Bun.spawn(["git", "init", "-q", dir], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  await writeFile(path.join(dir, "src-x.ts"), "export const x = 1;\n")
  const add = Bun.spawn(["git", "-C", dir, "add", "."], { stdout: "pipe", stderr: "pipe" })
  await add.exited
  const commit = Bun.spawn(
    ["git", "-C", dir, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "base"],
    { stdout: "pipe", stderr: "pipe" },
  )
  await commit.exited
  // Uncommitted phase work: the diff under distillation.
  await writeFile(path.join(dir, "src-x.ts"), "export const x = 2;\n")
  const transcript = [
    { role: "user", content: "Bump x to 2." },
    { role: "assistant", content: "Bump x to 3.", failed: true },
    { role: "tool", content: "gate test red: expected 2" },
    { role: "assistant", content: "Bumped x to 2; gates green." },
  ]
  await writeFile(path.join(dir, "trajectory.jsonl"), `${transcript.map((line) => JSON.stringify(line)).join("\n")}\n`)
  const gates = path.join(dir, ".factory", "runs", "r1", "gates", "2026-10-11-full")
  await mkdir(gates, { recursive: true })
  const greenSummary = { passed: true, findings: [] as unknown[] }
  await writeFile(path.join(gates, "summary.json"), `${JSON.stringify(greenSummary)}\n`)
  await appendAuditEntry(dir, { actor: "system", action: "stage.build" })
  return dir
}

describe("es improve export-dataset (#175)", () => {
  test("exports SFT JSONL plus a manifest from a verified worktree", async () => {
    root = await mkdtemp(path.join(tmpdir(), "es-export-cli-"))
    const worktree = await makeVerifiedWorktree()
    const out = path.join(root, "sft.jsonl")
    const result = await run(["improve", "export-dataset", "--kind", "sft", "--worktrees", worktree, "--output", out])
    expect(result.code).toBe(0)
    expect(result.out).toContain("1 sft record(s)")
    const record = JSON.parse((await readFile(out, "utf8")).trim())
    expect(record.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"))
    expect(manifest).toMatchObject({ format: "jsonl", kind: "sft", records: 1 })
    await rm(worktree, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  test("exports DPO pairs with the failed attempt as rejected", async () => {
    root = await mkdtemp(path.join(tmpdir(), "es-export-cli-"))
    const worktree = await makeVerifiedWorktree()
    const out = path.join(root, "dpo.jsonl")
    const result = await run(["improve", "export-dataset", "--kind", "dpo", "--worktrees", worktree, "--output", out])
    expect(result.code).toBe(0)
    const record = JSON.parse((await readFile(out, "utf8")).trim())
    expect(record.rejected).toContain("Bump x to 3.")
    expect(record.chosen).toContain("gates green")
    await rm(worktree, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  test("skips unverified worktrees with reasons; usage errors exit 2", async () => {
    root = await mkdtemp(path.join(tmpdir(), "es-export-cli-"))
    const bare = await mkdtemp(path.join(tmpdir(), "es-export-bare-"))
    const out = path.join(root, "sft.jsonl")
    const result = await run(["improve", "export-dataset", "--worktrees", bare, "--output", out])
    expect(result.code).toBe(0)
    expect(result.out).toContain("0 sft record(s)")
    expect(result.out).toContain("Skipped")
    const missing = await run(["improve", "export-dataset", "--output", out])
    expect(missing.code).toBe(2)
    expect(missing.out).toContain("Usage: es improve export-dataset")
    const badKind = await run(["improve", "export-dataset", "--kind", "rlhf", "--worktrees", bare, "--output", out])
    expect(badKind.code).toBe(2)
    await rm(bare, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })
})
