// Trust store: gate commands and project hooks run project-controlled code,
// so a human must approve each set by content hash before anything executes.
// Any change to the set requires re-approval. Stored in the user-global state
// dir, which agents can neither read nor write.
import { readFile } from "node:fs/promises"
import { userInfo } from "node:os"
import path from "node:path"
import { stateDir } from "../layout.ts"
import type { CommandCheck } from "../schema/gates.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"
import { hashJson } from "../util/hash.ts"
import { canonicalPath } from "./paths.ts"

export type TrustKind = "gates" | "hooks"

interface TrustEntry {
  hash: string
  lines: string[]
  approvedBy: string
  approvedAt: string
}

interface TrustFile {
  version: 2
  projects: Record<string, Partial<Record<TrustKind, TrustEntry>>>
}

const trustFile = (dir?: string) => path.join(dir ?? stateDir(), "trust.json")

/** Hash of the gate command set and the package.json scripts it can reach. */
export async function commandSetHash(
  dir: string,
  commands: readonly CommandCheck[],
): Promise<{ hash: string; lines: string[] }> {
  const lines = commands.map((item) => `${item.id}: ${item.command}`)
  let scripts: Record<string, string> = {}
  try {
    scripts = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")).scripts ?? {}
  } catch {
    // no package.json
  }
  const invokes = (command: string, name: string) => {
    const argv = command.split(/\s+/)
    const at = argv.indexOf("run")
    if (at >= 0 && argv.slice(at + 1).find((arg) => !arg.startsWith("-")) === name) return true
    return name === "test" && /^(npm|pnpm|yarn)\s+test\b/.test(command)
  }
  const reachable = Object.fromEntries(
    Object.entries(scripts).filter(([name]) => commands.some((item) => invokes(item.command, name))),
  )
  for (const [name, body] of Object.entries(reachable)) lines.push(`  script ${name}: ${body}`)
  return { hash: hashJson({ commands: commands.map((item) => [item.id, item.command]), scripts: reachable }), lines }
}

async function read(dir?: string): Promise<TrustFile> {
  const file = await readJson<{ version?: number; projects?: Record<string, any> }>(trustFile(dir))
  return file?.version === 2 ? (file as TrustFile) : { version: 2, projects: {} }
}

export async function isTrusted(root: string, hash: string, dir?: string, kind: TrustKind = "gates"): Promise<boolean> {
  return (await read(dir)).projects[canonicalPath(root)]?.[kind]?.hash === hash
}

/** Human-only: called from `es trust` (TTY) or the TUI trust dialog. */
export async function trustProject(
  root: string,
  hash: string,
  lines: string[],
  options: { approvedBy?: string; stateDir?: string; kind?: TrustKind } = {},
) {
  const file = trustFile(options.stateDir)
  await withLock(file, async () => {
    const current = await read(options.stateDir)
    const key = canonicalPath(root)
    current.projects[key] = {
      ...current.projects[key],
      [options.kind ?? "gates"]: {
        hash,
        lines,
        approvedBy: options.approvedBy ?? userInfo().username,
        approvedAt: new Date().toISOString(),
      },
    }
    await writeJson(file, current)
  })
}
