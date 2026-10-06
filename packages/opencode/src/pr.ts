// Release PR opener backed by the GitHub CLI. It pushes only the run's
// integration branch (never the base branch) and opens a draft PR for a human
// to review and merge.
import type { PrOpener } from "@heretek-ai/es-core"
import { git, run } from "@heretek-ai/es-core"

export const ghPrOpener: PrOpener = {
  id: "gh",
  async available(root) {
    const gh = await run(["gh", "auth", "status"], {
      cwd: root,
      timeoutMs: 15_000,
      passEnv: ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"],
    }).catch(() => undefined)
    if (gh?.code !== 0) return false
    const remote = await git(root, ["remote", "get-url", "origin"], { allowFail: true })
    return remote.code === 0
  },
  async open({ root, branch, base, title, body }) {
    if (branch === base || !branch.startsWith("factory/")) throw new Error(`refusing to push "${branch}"`)
    await git(root, ["push", "--set-upstream", "origin", `${branch}:${branch}`])
    const created = await run(
      ["gh", "pr", "create", "--draft", "--head", branch, "--base", base, "--title", title, "--body", body],
      {
        cwd: root,
        timeoutMs: 60_000,
        passEnv: ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"],
      },
    )
    const url = created.stdout
      .trim()
      .split("\n")
      .find((line) => /^https?:\/\//.test(line))
    if (created.code !== 0 || !url) throw new Error(`gh pr create failed: ${(created.stderr || created.stdout).trim()}`)
    return { url }
  },
}
