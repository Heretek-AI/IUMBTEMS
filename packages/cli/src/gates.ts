// `es gates`: run the gates from a terminal or git hook, and opt-in git hooks.
import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { formatReport, git, runGates } from "@heretek-ai/es-core"
import type { Args } from "./args.ts"
import type { HumanContext } from "./human.ts"
import { confirmHuman } from "./tty.ts"

async function changedFiles(root: string, staged: boolean) {
  if (staged)
    return (await git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { allowFail: true })).stdout
      .split("\n")
      .filter(Boolean)
  return (await git(root, ["status", "--porcelain=v1", "-uall"], { allowFail: true })).stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1)!)
}

export async function gatesRun(context: HumanContext, args: Args): Promise<number> {
  const full = args.flags.full === true
  const staged = args.flags.staged === true
  const touched = args.positionals.length ? args.positionals : await changedFiles(context.root, staged)
  const base = typeof args.flags.base === "string" ? args.flags.base : undefined
  const report = await runGates({
    root: context.root,
    scope: full || touched.length === 0 ? "full" : "touched",
    touched,
    ...(base ? { base } : {}),
    ...(context.stateDir ? { stateDir: context.stateDir } : {}),
  })
  context.print(args.flags.json ? JSON.stringify(report, null, 2) : formatReport(report))
  return report.passed ? 0 : 1
}

const HOOK = (mode: "pre-commit" | "pre-push") => `#!/bin/sh
# Installed by \`es gates install-git\` (Epistemic Swarm). Remove with \`es gates install-git --uninstall\`.
if command -v es >/dev/null 2>&1; then ES=es; else ES="npx --no-install es"; fi
exec $ES gates run ${mode === "pre-commit" ? "--staged" : "--full"}
`

export async function installGitHooks(context: HumanContext, args: Args): Promise<number> {
  const dir = path.join(context.root, ".factory", "git-hooks")
  if (args.flags.uninstall) {
    await git(context.root, ["config", "--unset", "core.hooksPath"], { allowFail: true })
    context.print("Removed core.hooksPath; git hooks are back to their defaults.")
    return 0
  }
  const current = (await git(context.root, ["config", "--get", "core.hooksPath"], { allowFail: true })).stdout.trim()
  const lines = [
    `Writes .factory/git-hooks/pre-commit (gates on staged files) and pre-push (full gates),`,
    `then sets core.hooksPath=.factory/git-hooks${current ? ` (replacing "${current}")` : ""}.`,
  ]
  if (!(await confirmHuman(context.io, "Install git hooks", lines, context.stateDir))) return 1
  await mkdir(dir, { recursive: true })
  for (const mode of ["pre-commit", "pre-push"] as const) {
    await writeFile(path.join(dir, mode), HOOK(mode))
    await chmod(path.join(dir, mode), 0o755)
  }
  await git(context.root, ["config", "core.hooksPath", ".factory/git-hooks"])
  context.print("Installed pre-commit and pre-push gates.")
  return 0
}
