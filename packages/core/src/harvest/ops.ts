// Harness-neutral darkharvest tools: plan (objective, candidates, read budget,
// license whitelist), discover (GitHub/GitLab search; reranking is the
// caller's job), scan (profile with provenance, fail-closed license), read
// (bounded candidate content), matrix (policy-enforced verdicts), complete
// (report, vendor plan, clean-room specs) and prior-art (related projects for
// brainstorm ideas).
import { seatOf } from "../agents/registry.ts"
import { words } from "../brainstorm/engine.ts"
import { factoryLayout } from "../layout.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { ToolRefusal } from "../ops/tools.ts"
import { DEFAULT_LICENSE_WHITELIST, type HarvestProfile, type HarvestRow, HarvestRowSchema } from "../schema/harvest.ts"
import { buildMatrix, checkVerdict, renderHarvest } from "./matrix.ts"
import { candidateId, type HarvestSource, parseSource, readCandidate, scanSource } from "./scan.ts"
import { githubApi, gitlabApi, type RemoteRepo } from "./sources.ts"
import {
  readHarvestPlan,
  readMatrix,
  readProfile,
  readProfiles,
  startHarvestRun,
  writeHarvestResult,
  writeMatrix,
  writeProfile,
} from "./store.ts"

export interface HarvestOpsContext {
  readonly root: string
  readonly fetch?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
  readonly clone?: (url: string, dir: string) => Promise<unknown>
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const repoLine = (repo: RemoteRepo) =>
  `- ${repo.fullName ?? repo.name} — ★${repo.stars ?? "?"}${repo.updatedAt ? `, updated ${repo.updatedAt.slice(0, 10)}` : ""}${repo.license ? `, license ${repo.license} (API, unverified)` : ""}\n  ${repo.url}${repo.description ? `\n  ${repo.description.slice(0, 200)}` : ""}`

export function harvestTools(context: HarvestOpsContext): EsToolDef[] {
  const { root } = context
  const api = () => ({
    ...(context.fetch ? { fetch: context.fetch } : {}),
    ...(context.env ? { env: context.env } : {}),
  })

  return [
    {
      name: "es_harvest_plan",
      description:
        "Harvester only: freeze the teardown objective, the candidate list, the per-candidate read budget and the license whitelist.",
      input: object(
        {
          objective: { type: "string", description: "What are we harvesting, and for what?" },
          candidates: {
            type: "array",
            description:
              'Sources: "github:owner/repo", "gitlab:group/project", "git:https://…", "npm:name", "local:./path".',
            items: object({ name: { type: "string" }, source: { type: "string" } }, ["name", "source"]),
          },
          readTokensPerCandidate: {
            type: "number",
            description: "Content read budget per candidate (default 40000 tokens).",
          },
          whitelist: {
            type: "array",
            items: { type: "string" },
            description: "SPDX ids that may be depended on or vendored.",
          },
          force: { type: "boolean" },
        },
        ["objective", "candidates"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may plan a darkharvest.")
        const objective = String(input.objective ?? "").trim()
        if (!objective) throw new ToolRefusal("Give the teardown an objective.")
        const candidates = Array.isArray(input.candidates) ? input.candidates : []
        if (!candidates.length) throw new ToolRefusal("Give at least one candidate.")
        const existing = await readHarvestPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the current plan: ${error.message}`)
        })
        if (existing && input.force !== true)
          throw new ToolRefusal("A darkharvest is already planned. Pass force:true to replace it and drop its scans.")
        const seen = new Set<string>()
        const planned: Array<{ id: string; name: string; source: string }> = []
        for (const raw of candidates) {
          const name = String(raw?.name ?? "").trim()
          const spec = String(raw?.source ?? "").trim()
          if (!name || !spec) throw new ToolRefusal("Every candidate needs a name and a source.")
          try {
            parseSource(spec)
          } catch (error) {
            throw new ToolRefusal(error instanceof Error ? error.message : String(error))
          }
          let id = candidateId(name)
          while (seen.has(id)) id = `${id}-2`
          seen.add(id)
          planned.push({ id, name, source: spec })
        }
        const whitelist =
          Array.isArray(input.whitelist) && input.whitelist.length
            ? input.whitelist.map(String)
            : [...DEFAULT_LICENSE_WHITELIST]
        const plan = {
          version: 1 as const,
          objective,
          candidates: planned,
          readTokensPerCandidate: input.readTokensPerCandidate ? Number(input.readTokensPerCandidate) : 40_000,
          whitelist,
          createdAt: new Date().toISOString(),
        }
        await startHarvestRun(root, plan)
        return [
          `Darkharvest planned: ${objective}`,
          `Candidates (${planned.length}): ${planned.map((item) => `${item.id} ← ${item.source}`).join(", ")}`,
          `Read budget: ${plan.readTokensPerCandidate} tokens per candidate · whitelist: ${whitelist.join(", ")}`,
          "",
          "Next steps:",
          "1. es_harvest_scan each candidate (profiles land under .factory/harvest/<id>/).",
          "2. Read what you need with es_harvest_read (the budget is enforced).",
          "3. Propose the feature matrix with es_harvest_matrix; the license policy rewrites any depend/vendor it cannot authorize.",
          "4. es_harvest_complete writes HARVEST.md, VENDOR-PLAN.md and clean-room specs.",
        ].join("\n")
      },
    },
    {
      name: "es_harvest_discover",
      description:
        "Harvester only: search GitHub (and GitLab) for candidates by query, topic or dependency overlap. You rerank; the human edits the list.",
      input: object({
        queries: { type: "array", items: { type: "string" } },
        topics: { type: "array", items: { type: "string" } },
        dependencies: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        gitlab: { type: "boolean" },
      }),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may discover candidates.")
        const queries: string[] = [
          ...(Array.isArray(input.queries) ? input.queries.map(String) : []),
          ...(Array.isArray(input.topics) ? input.topics.map((topic: string) => `topic:${topic}`) : []),
          ...(Array.isArray(input.dependencies) ? input.dependencies.map((dep: string) => `"${dep}" in:readme`) : []),
        ].filter((query) => query.trim().length > 0)
        if (!queries.length) throw new ToolRefusal("Give at least one query, topic or dependency.")
        const limit = Math.min(Number(input.limit ?? 5) || 5, 20)
        const warnings: string[] = []
        const found = new Map<string, RemoteRepo>()
        const runSearch = async (search: (query: string, limit: number) => Promise<RemoteRepo[]>, provider: string) => {
          for (const query of queries) {
            try {
              for (const repo of await search(query, limit)) found.set(repo.fullName ?? repo.url, repo)
            } catch (error) {
              warnings.push(
                `${provider} search failed for "${query}": ${error instanceof Error ? error.message : String(error)} (UNVERIFIED)`,
              )
            }
          }
        }
        await runSearch(githubApi(api()).search, "GitHub")
        if (input.gitlab === true) await runSearch(gitlabApi(api()).search, "GitLab")
        const lines = [...found.values()]
          .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
          .slice(0, limit * Math.max(queries.length, 1))
          .map(repoLine)
        return [
          `Discovery (${found.size} candidate(s); license fields are API claims, not verified):`,
          lines.length ? lines.join("\n") : "No results.",
          ...warnings,
          "Pick the list with the human, then es_harvest_plan with the chosen sources.",
        ].join("\n")
      },
    },
    {
      name: "es_harvest_scan",
      description:
        "Harvester only: clone or read a planned candidate, index it and detect its license (fail-closed). Writes .factory/harvest/<id>/profile.json.",
      input: object({ candidate: { type: "string", description: "Candidate id from the plan." } }, ["candidate"]),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may scan candidates.")
        const plan = await readHarvestPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No darkharvest plan. Call es_harvest_plan first.")
        const id = String(input.candidate ?? "")
        const candidate = plan.candidates.find((item) => item.id === id)
        if (!candidate)
          throw new ToolRefusal(
            `Unknown candidate "${id}". Planned: ${plan.candidates.map((item) => item.id).join(", ")}.`,
          )
        const source: HarvestSource = parseSource(candidate.source)
        let profile: HarvestProfile
        try {
          profile = await scanSource(root, id, source, {
            ...api(),
            ...(context.clone ? { clone: context.clone } : {}),
            ...(toolContext.signal ? { signal: toolContext.signal } : {}),
          })
        } catch (error) {
          throw new ToolRefusal(`Scan of "${id}" failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        await writeProfile(root, profile)
        const policy = checkVerdict("depend", profile.license, plan.whitelist)
        return [
          `Scanned ${id}: ${profile.name}`,
          `License: ${profile.license.spdx} (${profile.license.family}, ${profile.license.source}, ${profile.license.verified ? "verified" : "UNVERIFIED"})`,
          `Size: ${profile.size.files} files, ~${profile.size.tokens} tokens · ${Object.keys(profile.languages).length} language(s) · deps ${profile.dependencies.runtime.length}`,
          ...profile.warnings.map((warning) => `⚠ ${warning}`),
          policy.downgraded
            ? `depend/vendor: NOT authorized — ${policy.downgraded}`
            : `depend/vendor: authorized with ${policy.attribution}`,
        ].join("\n")
      },
    },
    {
      name: "es_harvest_read",
      description: "Harvester only: read candidate content on demand, inside the per-candidate token budget.",
      input: object(
        {
          candidate: { type: "string" },
          file: { type: "string" },
          offset: { type: "number" },
          maxChars: { type: "number" },
        },
        ["candidate", "file"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may read candidates.")
        const plan = await readHarvestPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No darkharvest plan.")
        if (!(await readProfile(root, String(input.candidate))))
          throw new ToolRefusal(`Scan "${input.candidate}" first.`)
        const read = await readCandidate(root, String(input.candidate), String(input.file), {
          ...(input.offset !== undefined ? { offset: Number(input.offset) } : {}),
          ...(input.maxChars !== undefined ? { maxChars: Number(input.maxChars) } : {}),
          budgetTokens: plan.readTokensPerCandidate,
        }).catch((error: Error) => {
          throw new ToolRefusal(error.message)
        })
        return [
          `${read.file} (offset ${read.offset}${read.truncated ? ", truncated" : ""}; ${read.spent}/${read.budget} tokens read for ${input.candidate})`,
          "",
          read.text,
        ].join("\n")
      },
    },
    {
      name: "es_harvest_matrix",
      description:
        "Harvester only: submit the feature matrix. The license policy rewrites depend/vendor that cannot be authorized and attaches attribution.",
      input: object(
        {
          rows: {
            type: "array",
            items: object(
              {
                feature: { type: "string" },
                cells: {
                  type: "array",
                  items: object(
                    {
                      candidate: { type: "string" },
                      verdict: { type: "string", enum: ["depend", "vendor", "clean-room", "skip"] },
                      evidence: { type: "string" },
                      attribution: { type: "string" },
                    },
                    ["candidate", "verdict"],
                  ),
                },
              },
              ["feature", "cells"],
            ),
          },
        },
        ["rows"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may build the matrix.")
        const plan = await readHarvestPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No darkharvest plan.")
        let rows: HarvestRow[]
        try {
          rows = HarvestRowSchema.array().parse(input.rows)
        } catch {
          throw new ToolRefusal(
            "Rows must be { feature, cells: [{ candidate, verdict: depend|vendor|clean-room|skip }] }.",
          )
        }
        const profiles = new Map((await readProfiles(root)).map((profile) => [profile.id, profile]))
        const missing = plan.candidates.filter((candidate) => !profiles.has(candidate.id))
        if (missing.length)
          throw new ToolRefusal(`Scan these candidates first: ${missing.map((item) => item.id).join(", ")}.`)
        const built = buildMatrix(
          plan.candidates.map((candidate) => candidate.id),
          profiles,
          rows,
          plan.whitelist,
        )
        await writeMatrix(root, built.matrix)
        const counts = new Map<string, number>()
        for (const row of built.matrix.rows)
          for (const cell of row.cells) counts.set(cell.verdict, (counts.get(cell.verdict) ?? 0) + 1)
        return [
          `Matrix written: ${built.matrix.rows.length} feature(s) across ${plan.candidates.length} candidate(s).`,
          `Verdicts: ${[...counts].map(([verdict, count]) => `${verdict} ${count}`).join(", ")}`,
          ...(built.downgrades.length
            ? [
                "Policy downgrades:",
                ...built.downgrades.map(
                  (item) => `- ${item.candidate} · ${item.feature}: ${item.reason} (${item.from} → ${item.to})`,
                ),
              ]
            : []),
          "es_harvest_complete writes the report when the matrix is what you want.",
        ].join("\n")
      },
    },
    {
      name: "es_harvest_complete",
      description: "Harvester only: finalise the teardown; writes HARVEST.md, VENDOR-PLAN.md and clean-room specs.",
      input: object({
        allowPartial: { type: "boolean", description: "Finish with unscanned candidates recorded as gaps." },
      }),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may complete a darkharvest.")
        const plan = await readHarvestPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No darkharvest plan.")
        const profiles = await readProfiles(root)
        const scanned = new Set(profiles.map((profile) => profile.id))
        const missing = plan.candidates.filter((candidate) => !scanned.has(candidate.id))
        if (missing.length && input.allowPartial !== true)
          throw new ToolRefusal(
            `Candidates not scanned: ${missing.map((item) => item.id).join(", ")}. Scan them, or pass allowPartial:true to record them as gaps.`,
          )
        const matrix = await readMatrix(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the matrix: ${error.message}`)
        })
        if (!matrix) throw new ToolRefusal("No matrix yet. Build it with es_harvest_matrix first.")
        const rendered = renderHarvest(plan.objective, profiles, matrix)
        await writeHarvestResult(root, plan.objective, profiles, matrix, rendered)
        const counts = new Map<string, number>()
        for (const row of matrix.rows)
          for (const cell of row.cells) counts.set(cell.verdict, (counts.get(cell.verdict) ?? 0) + 1)
        const base = factoryLayout(root).dir
        return [
          `Darkharvest complete: ${profiles.length} profile(s), ${matrix.rows.length} feature(s)${missing.length ? `, ${missing.length} gap(s)` : ""}.`,
          `Verdicts: ${[...counts].map(([verdict, count]) => `${verdict} ${count}`).join(", ")}`,
          `Written: ${base}/harvest/harvest.json, HARVEST.md, VENDOR-PLAN.md${rendered.cleanRoom.length ? ` and ${rendered.cleanRoom.length} clean-room spec(s)` : ""}`,
        ].join("\n")
      },
    },
    {
      name: "es_harvest_prior_art",
      description:
        "Harvester only: find projects related to brainstorm ideas. You decide the relation (novel/similar/existing) and pass the result to es_brainstorm_complete.",
      input: object(
        {
          ideas: {
            type: "array",
            items: object({ id: { type: "string" }, title: { type: "string" }, text: { type: "string" } }, [
              "id",
              "title",
            ]),
          },
          limit: { type: "number" },
        },
        ["ideas"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may run prior-art checks.")
        const ideas = Array.isArray(input.ideas) ? input.ideas : []
        if (!ideas.length) throw new ToolRefusal("Give at least one idea.")
        const limit = Math.min(Number(input.limit ?? 3) || 3, 10)
        const github = githubApi(api())
        const lines: string[] = []
        for (const idea of ideas) {
          const keywords = words(`${idea.title ?? ""} ${idea.text ?? ""}`)
            .slice(0, 6)
            .join(" ")
          if (!keywords) {
            lines.push(`- ${idea.id}: no keywords; relation "novel" by default`)
            continue
          }
          try {
            const results = await github.search(`${keywords} in:name,description,readme`, limit)
            lines.push(
              `- ${idea.id} "${idea.title}" — ${results.length ? "related projects:" : "no related projects found (candidate for novel):"}`,
              ...results.map((repo) => `  · ${repo.fullName ?? repo.name} — ${repo.url}`),
            )
          } catch (error) {
            lines.push(
              `- ${idea.id}: prior-art search failed (${error instanceof Error ? error.message : String(error)}); UNVERIFIED — do not claim novelty`,
            )
          }
        }
        return [
          "Prior-art candidates (relations and novelty are your judgement; searches that failed are UNVERIFIED):",
          lines.join("\n"),
          'Record the result: pass priorArt:[{ title, url, relation: "novel"|"similar"|"existing", note }] to es_brainstorm_complete.',
        ].join("\n")
      },
    },
  ]
}
