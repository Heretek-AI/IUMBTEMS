// Trust store: gate commands run project code (test runners, package scripts),
// so a project's command set must be approved by a human before any gate
// executes it. The approval pins a hash of the commands plus the package
// scripts they invoke; any change requires re-approval. Stored in the
// user-global state dir, which agents cannot read or write.
import { readFile } from "node:fs/promises"
import { userInfo } from "node:os"
import path from "node:path"
import { stateDir } from "../layout.ts"
import type { CommandCheck } from "../schema/gates.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"
import { hashJson } from "../util/hash.ts"
import { canonicalPath } from "./paths.ts"

interface TrustFile {
  version: 1
  projects: Record<string, { hash: string; commands: string[]; approvedBy: string; approvedAt: string }>
}

const trustFile = (dir?: string) => path.join(dir ?? stateDir(), "trust.json")

/** Hash of the command set and the package.json scripts it can reach. */
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

export async function isTrusted(root: string, hash: string, dir?: string): Promise<boolean> {
  const file = await readJson<TrustFile>(trustFile(dir))
  return file?.projects[canonicalPath(root)]?.hash === hash
}

/** Human-only: called from `es trust` (TTY) or the TUI trust dialog. */
export async function trustProject(
  root: string,
  hash: string,
  commands: string[],
  options: { approvedBy?: string; stateDir?: string } = {},
) {
  const file = trustFile(options.stateDir)
  await withLock(file, async () => {
    const current = (await readJson<TrustFile>(file)) ?? { version: 1, projects: {} }
    current.projects[canonicalPath(root)] = {
      hash,
      commands,
      approvedBy: options.approvedBy ?? userInfo().username,
      approvedAt: new Date().toISOString(),
    }
    await writeJson(file, current)
  })
}
