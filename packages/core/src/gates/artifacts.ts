// Schema validation of factory artifacts as a gate, so a malformed spec or
// gates.json is a structured finding rather than a runtime surprise.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { auditMarkdown } from "../research/auditor.ts"
import { researchCache } from "../research/ops.ts"
import { FrontierSchema } from "../schema/frontier.ts"
import { type GateFinding, GatesConfigSchema } from "../schema/gates.ts"
import { parseGoalMarkdown } from "../schema/goal.ts"
import { RoadmapSchema } from "../schema/roadmap.ts"
import { parseJsonc } from "../util/jsonc.ts"

const issueText = (error: unknown) => {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> })?.issues
  return issues
    ? issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")
    : error instanceof Error
      ? error.message
      : String(error)
}

export async function validateArtifacts(root: string): Promise<GateFinding[]> {
  const layout = factoryLayout(root)
  const findings: GateFinding[] = []
  const check = async (file: string, rule: string, validate: (text: string) => unknown) => {
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) return
    try {
      validate(text)
    } catch (error) {
      findings.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        rule,
        severity: "error",
        message: issueText(error),
        check: "artifacts",
      })
    }
  }
  await check(layout.frontier, "schema/frontier", (text) => FrontierSchema.parse(JSON.parse(text)))
  await check(layout.roadmap, "schema/roadmap", (text) => RoadmapSchema.parse(JSON.parse(text)))
  await check(layout.gates, "schema/gates-config", (text) => GatesConfigSchema.parse(parseJsonc(text)))
  let specs: string[] = []
  try {
    specs = await readdir(layout.specs)
  } catch {
    // no specs yet
  }
  const report = await readFile(layout.researchReport, "utf8").catch(() => undefined)
  if (report !== undefined) {
    const audit = await auditMarkdown(report, researchCache(root))
    for (const claim of audit.claims.filter((item) => item.status !== "grounded"))
      findings.push({
        file: ".factory/research/REPORT.md",
        line: claim.line,
        rule: `research/${claim.status}`,
        severity: "error",
        message: claim.reason ?? claim.status,
        fixHint: "Tag the claim and quote the cached source verbatim, or prune it (es_research_audit prune:true).",
        check: "artifacts",
      })
  }
  for (const id of specs)
    await check(layout.spec(id), "schema/goal", (text) => {
      const goal = parseGoalMarkdown(text)
      if (goal.frontmatter.phase !== id)
        throw new Error(`declares phase "${goal.frontmatter.phase}" in directory "${id}"`)
    })
  return findings
}
