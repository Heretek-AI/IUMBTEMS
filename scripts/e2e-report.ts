// Deterministic debug/feedback report for the E2E eval run (`bun run evals`).
// Reads an evals/results/<stamp>.json (or the newest one) plus environment
// context (model, opencode version, git SHA, plugin version) and writes a
// human- and agent-readable markdown report next to it. Pure and offline: no
// model calls, no secrets touched, safe to run with `if: always()` in CI.
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const resultsDir = path.join(root, "evals/results")

interface EvalRow {
  id: string
  agent?: string
  description?: string
  pass: boolean
  exitCode?: number | null
  capped?: boolean
  timedOut?: boolean
  overBudget?: boolean
  maxSteps?: number
  steps?: number
  tools?: readonly string[]
  completed?: readonly string[]
  costUSD?: number
  errors?: readonly string[]
  textExcerpt?: string
  failures?: readonly string[]
  /** Where the failed case's workspace, events and stderr were kept. */
  kept?: string
}

interface EvalFile {
  at?: string
  model?: string
  stepCeiling?: number
  budgetUSD?: number
  spentUSD?: number
  results?: EvalRow[]
}

function usage(): never {
  console.error("usage: bun scripts/e2e-report.ts [results-json] [opencode-version] [git-sha]")
  process.exit(2)
}

const arg = process.argv[2]
const opencodeVersion =
  process.argv[3] ?? process.env.ES_OPENCODE_VERSION ?? (await safeCommand("opencode", ["--version"]))
const gitSha = process.argv[4] ?? process.env.GITHUB_SHA ?? (await safeCommand("git", ["rev-parse", "--short", "HEAD"]))

async function safeCommand(binary: string, args: string[]): Promise<string> {
  try {
    const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(child.stdout).text()
    await child.exited
    return out.trim().slice(0, 80) || "unknown"
  } catch {
    return "unknown"
  }
}

async function pickResultsFile(): Promise<string> {
  if (arg) return path.isAbsolute(arg) ? arg : path.join(root, arg)
  // Current `bun run evals` writes flat <stamp>.json files. Timestamped
  // subdirectories underneath hold a legacy schema (no top-level `results`);
  // accept those only if they match the current shape.
  const flat = (await readdir(resultsDir).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".json"))
    .sort()
  const flatLatest = flat.at(-1)
  if (flatLatest) return path.join(resultsDir, flatLatest)
  const nested: string[] = []
  for (const entry of await readdir(resultsDir).catch(() => [] as string[])) {
    if (!entry.endsWith(".json")) {
      const dir = path.join(resultsDir, entry)
      for (const file of await readdir(dir).catch(() => [] as string[])) {
        if (file.endsWith(".json")) nested.push(path.join(dir, file))
      }
    }
  }
  // Newest first by filename (stamps sort lexicographically); first file with
  // the current schema wins.
  nested.sort().reverse()
  for (const file of nested) {
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as { results?: unknown }
      if (Array.isArray(data.results)) return file
    } catch {
      // not readable JSON; keep looking
    }
  }
  console.error(`e2e-report: no current-format results JSON in ${resultsDir}; run \`bun run evals\` first.`)
  process.exit(1)
}

const resultsPath = await pickResultsFile()
const raw = await readFile(resultsPath, "utf8").catch(() => usage())
const data = JSON.parse(raw) as EvalFile
const rows = data.results ?? []
const model = data.model ?? process.env.ES_EVAL_MODEL ?? "unknown"
const passed = rows.filter((row) => row.pass).length
const pluginPkg = await readFile(path.join(root, "packages/opencode/package.json"), "utf8")
  .then((text) => (JSON.parse(text) as { version?: string }).version ?? "unknown")
  .catch(() => "unknown")
const corePkg = await readFile(path.join(root, "packages/core/package.json"), "utf8")
  .then((text) => (JSON.parse(text) as { version?: string }).version ?? "unknown")
  .catch(() => "unknown")

const lines: string[] = []
lines.push(`# E2E feedback report`)
lines.push(``)
lines.push(`- At: ${data.at ?? "unknown"} (source: \`${path.relative(root, resultsPath)}\`)`)
lines.push(`- Model: \`${model}\``)
lines.push(`- opencode: \`${opencodeVersion}\` (plugin \`@heretek-ai/epistemic-swarm@${pluginPkg}\`, core \`@${corePkg}\`)`)
lines.push(`- Git: \`${gitSha}\``)
lines.push(`- Step caps: per case (ceiling ${data.stepCeiling ?? "unknown"})`)
lines.push(
  `- Spend: $${(data.spentUSD ?? 0).toFixed(4)}${data.budgetUSD === undefined ? " (no budget set)" : ` of $${data.budgetUSD}`}`,
)
lines.push(`- Result: **${passed}/${rows.length} passed**${passed === rows.length ? " ✅" : " ❌"}`)
lines.push(``)
lines.push(`| case | agent | steps | cost | tools | verdict | failures |`)
lines.push(`| ---- | ----- | ----- | ---- | ----- | ------- | -------- |`)
for (const row of rows) {
  const failures = (row.failures ?? []).join("; ").slice(0, 160).replaceAll("|", "\\|")
  lines.push(
    `| \`${row.id}\` | ${row.agent ?? "?"} | ${row.steps ?? "?"}/${row.maxSteps ?? "?"} | $${(row.costUSD ?? 0).toFixed(4)} | ${(row.tools ?? []).join(", ") || "—"} | ${row.pass ? "PASS" : "FAIL"} | ${failures || "—"} |`,
  )
}
lines.push(``)
for (const row of rows) {
  lines.push(`## ${row.pass ? "PASS" : "FAIL"} ${row.id}`)
  lines.push(``)
  if (row.description) lines.push(`${row.description}`)
  lines.push(``)
  lines.push(
    `- Agent: \`${row.agent ?? "?"}\`, exit: ${row.exitCode ?? "?"}, capped: ${row.capped ?? "?"}, timed out: ${row.timedOut ?? "?"}, over budget: ${row.overBudget ?? "?"}`,
  )
  const refused = (row.tools ?? []).filter((tool, index, all) => all.indexOf(tool) === index && !(row.completed ?? []).includes(tool))
  if (row.completed && refused.length > 0) lines.push(`- Called but never completed: ${refused.join(", ")}`)
  if (row.kept) lines.push(`- Evidence kept at \`${row.kept}/\` (project, \`factory/\` mirror of its \`.factory/\`, \`events.jsonl\`, \`stderr.txt\`)`)
  if ((row.errors ?? []).length > 0) {
    lines.push(`- Error events:`)
    for (const error of row.errors!) lines.push(`  - ${error.slice(0, 300)}`)
  }
  if ((row.failures ?? []).length > 0) {
    lines.push(`- Failures:`)
    for (const failure of row.failures!) lines.push(`  - ${failure.slice(0, 300)}`)
  }
  const excerpt = (row.textExcerpt ?? "").trim()
  if (excerpt) {
    lines.push(`- Agent output (first 2000 chars):`)
    lines.push(`  \`\`\``)
    for (const line of excerpt.split("\n").slice(0, 30)) lines.push(`  ${line}`)
    lines.push(`  \`\`\``)
  }
  lines.push(``)
}
lines.push(`## Reproducing locally`)
lines.push(``)
lines.push(`\`\`\`bash`)
lines.push(`export ES_EVAL_MODEL="${model}"`)
lines.push(`export OPENCODE_API_KEY="<key for the model's provider>"  # or \$ES_EVAL_KEY_VAR equivalent`)
lines.push(`export ES_EVAL_MAX_USD=15  # optional spend budget for the whole run`)
lines.push(`npm install --global --ignore-scripts @opencode/cli-linux-x64@2.0.24`)
lines.push(`bun run evals`)
lines.push(`bun scripts/e2e-report.ts  # regenerates this file from the newest evals/results/*.json`)
lines.push(`\`\`\``)
lines.push(``)
lines.push(`## What to look at when a case fails`)
lines.push(``)
lines.push(`1. \`exit != 0\` with no error events → CLI/host crash; rerun that case's prompt by hand (see \`evals/cases/<id>.json\`).`)
lines.push(`2. \`capped: true\` → the agent ran past its case's step cap; check \`tools\` for a repeated call cycle, then the kept \`events.jsonl\`.`)
lines.push(`3. \`must not call\` / \`did not call\` → seat scoping or prompt regression in \`packages/core/assets\` or the registry.`)
lines.push(`   \`called but did not complete\` → the tool refused; its reason is in the kept \`events.jsonl\` (tool_use with status error).`)
lines.push(`4. \`missing: <text>\` → behaviour drift in the seat's first-turn answer; compare against the case description.`)

const reportPath = resultsPath.replace(/\.json$/, ".md")
await writeFile(reportPath, `${lines.join("\n")}\n`)
console.log(`e2e-report: wrote ${path.relative(root, reportPath)} (${passed}/${rows.length} passed)`)
