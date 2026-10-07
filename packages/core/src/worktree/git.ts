// Git operations the factory needs, argv-only (no shell), with errors that
// carry git's own message. Phase work happens in worktrees under
// .factory/worktrees/<phase>; the user's checkout is never switched.
import { run } from "../util/proc.ts"

export class GitError extends Error {}

export async function git(cwd: string, args: readonly string[], options: { allowFail?: boolean } = {}) {
  const result = await run(["git", ...args], {
    cwd,
    timeoutMs: 60_000,
    passEnv: ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"],
  })
  if (result.code !== 0 && !options.allowFail)
    throw new GitError(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  return result
}

const out = async (cwd: string, args: readonly string[]) => (await git(cwd, args)).stdout.trim()

export const isRepo = async (dir: string) =>
  (await git(dir, ["rev-parse", "--git-dir"], { allowFail: true })).code === 0
export const headCommit = (dir: string) => out(dir, ["rev-parse", "HEAD"])
export const revParse = (dir: string, ref: string) => out(dir, ["rev-parse", "--verify", `${ref}^{commit}`])

export async function currentBranch(dir: string): Promise<string | undefined> {
  const result = await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })
  return result.code === 0 ? result.stdout.trim() : undefined
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  return (await git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true })).code === 0
}

/** Create or reset `branch` to `from` without touching any checkout. */
export const setBranch = (root: string, branch: string, from: string) => git(root, ["branch", "-f", branch, from])

export async function addWorktree(root: string, dir: string, branch: string, from: string): Promise<void> {
  await git(root, ["worktree", "prune"], { allowFail: true })
  await git(root, ["worktree", "add", "-B", branch, dir, from])
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  const result = await git(root, ["worktree", "remove", dir], { allowFail: true })
  if (result.code !== 0 && !/is not a working tree|No such file/.test(result.stderr))
    throw new GitError(`git worktree remove failed: ${result.stderr.trim()}`)
}

/** Stage everything and commit; returns the new commit, or undefined when there was nothing to commit. */
export async function commitAll(
  dir: string,
  message: string,
  author = "Epistemic Swarm <factory@epistemic-swarm.local>",
) {
  await git(dir, ["add", "-A"])
  const staged = await git(dir, ["diff", "--cached", "--quiet"], { allowFail: true })
  if (staged.code === 0) return undefined
  const [name, email] = /^([^<]*) <([^>]*)>$/.exec(author)?.slice(1) ?? [
    "Epistemic Swarm",
    "factory@epistemic-swarm.local",
  ]
  await git(dir, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--no-verify", "-m", message])
  return headCommit(dir)
}

export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true })).code === 0
}

export interface DiffStats {
  readonly added: number
  readonly removed: number
  readonly files: readonly string[]
}

/** Diff of the worktree (committed and uncommitted, plus untracked files) against `base`. */
export async function diffStats(dir: string, base: string): Promise<DiffStats> {
  await git(dir, ["add", "-A", "--intent-to-add"], { allowFail: true })
  const numstat = await out(dir, ["diff", "--numstat", base])
  let added = 0
  let removed = 0
  const files: string[] = []
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, r, ...name] = line.split("\t")
    if (a !== "-") added += Number(a)
    if (r !== "-") removed += Number(r)
    files.push(name.join("\t"))
  }
  return { added, removed, files }
}

export async function changedFiles(dir: string, base: string): Promise<string[]> {
  return (await diffStats(dir, base)).files.slice()
}

/** Files touched by each commit between base and HEAD, oldest first. */
export async function commitFiles(dir: string, base: string): Promise<Array<{ commit: string; files: string[] }>> {
  const log = await out(dir, ["log", "--reverse", "--format=%H", "--name-only", `${base}..HEAD`])
  const commits: Array<{ commit: string; files: string[] }> = []
  for (const line of log.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) commits.push({ commit: line, files: [] })
    else if (line.trim() && commits.length) commits.at(-1)!.files.push(line.trim())
  }
  return commits
}

/** Fingerprint of a checkout's uncommitted state (for post-run diff checks). */
export async function treeFingerprint(dir: string): Promise<string> {
  const status = await git(dir, ["status", "--porcelain=v1", "-uall"], { allowFail: true })
  const diff = await git(dir, ["diff", "HEAD"], { allowFail: true })
  const { sha256 } = await import("../util/hash.ts")
  return sha256(status.stdout + "\0" + diff.stdout)
}
