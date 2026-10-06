// Append-only journal of side-effecting steps (worktree creation, commits,
// branch moves, PR creation). Each step has a stable id; `once` skips a step
// already journaled and returns its recorded result, so `/factory resume`
// after a crash replays safely.
import { readFile } from "node:fs/promises"
import { factoryLayout } from "../layout.ts"
import { appendLine, withLock } from "../util/fs.ts"

export interface JournalEntry {
  readonly step: string
  readonly at: string
  readonly result: unknown
}

export async function readJournal(root: string): Promise<JournalEntry[]> {
  try {
    return (await readFile(factoryLayout(root).journal, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEntry)
  } catch (error: any) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

export async function once<T>(root: string, step: string, fn: () => Promise<T>): Promise<T> {
  const file = factoryLayout(root).journal
  const done = (await readJournal(root)).find((entry) => entry.step === step)
  if (done) return done.result as T
  const result = await fn()
  await withLock(file, () =>
    appendLine(file, JSON.stringify({ step, at: new Date().toISOString(), result: result ?? null })),
  )
  return result
}
