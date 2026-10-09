// Harness-neutral darkharvest tools: plan (objective, candidates, read budget,
// license whitelist), discover (GitHub/GitLab search; reranking is the
// caller's job), scan (profile with provenance, fail-closed license), read
// (bounded candidate content), matrix (policy-enforced verdicts), complete
// (report, vendor plan, clean-room specs) and prior-art (related projects for
// brainstorm ideas).
import path from "node:path"
import { seatOf } from "../agents/registry.ts"
import { words } from "../brainstorm/engine.ts"
import { parseRunId } from "../brainstorm/store.ts"
import { factoryLayout } from "../layout.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { ToolRefusal } from "../ops/tools.ts"
import { DEFAULT_LICENSE_WHITELIST, type HarvestProfile, type HarvestRow, HarvestRowSchema } from "../schema/harvest.ts"
import { canonicalPath } from "../trust/paths.ts"
import { buildMatrix, checkVerdict, recheckMatrix, renderHarvest } from "./matrix.ts"
import { type PriorArtSearch, recordPriorArt } from "./prior-art.ts"
import {
  assertSourceAllowed,
  candidateId,
  type HarvestSource,
  parseSource,
  readCandidate,
  scanSource,
  withCurrentLicenses,
} from "./scan.ts"
import { discoverRepos, githubApi, repoLine } from "./sources.ts"
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
  /** SPDX ids that may be depended on or vendored (config override). */
  readonly whitelist?: readonly string[]
  /** The user-global state dir agents may never harvest (default: stateDir()). */
  readonly stateDir?: string
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const runOf = (input: { run?: unknown }): string => {
  try {
    return parseRunId(input.run)
  } catch (error) {
    throw new ToolRefusal(error instanceof Error ? error.message : String(error))
  }
}

/** Seats that may run a deterministic license-and-verdict scan without a harvester (#109). */
const mayTarget = (agent: string | undefined): boolean => {
  const seat = seatOf(agent)
  return seat === "grill" || seat === "factory" || seat === "scout" || seat === "harvester"
}
/** Seats that may search prior art for a brainstorm (#109): the harvester plus every callable-brainstorm caller. */
const maySearchPriorArt = (agent: string | undefined): boolean => {
  const seat = seatOf(agent)
  return seat === "harvester" || seat === "brainstormer" || seat === "grill" || seat === "factory"
}

export function harvestTools(context: HarvestOpsContext): EsToolDef[] {
  const { root } = context
  // Agents never scan outside the project or into the private state dir.
  const sourcePolicy = { ...(context.stateDir ? { stateDir: context.stateDir } : {}) }
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
          run: {
            type: "string",
            description: "Plan run id (lowercase/dashes; the human /harvest is the default run).",
          },
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
        const run = runOf(input)
        const objective = String(input.objective ?? "").trim()
        if (!objective) throw new ToolRefusal("Give the teardown an objective.")
        const candidates = Array.isArray(input.candidates) ? input.candidates : []
        if (!candidates.length) throw new ToolRefusal("Give at least one candidate.")
        const existing = await readHarvestPlan(root, run).catch((error: Error) => {
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
            assertSourceAllowed(root, parseSource(spec), sourcePolicy)
          } catch (error) {
            throw new ToolRefusal(error instanceof Error ? error.message : String(error))
          }
          let id = candidateId(name)
          // "notes" and "clean-room" are reserved directories under .factory/harvest.
          while (seen.has(id) || id === "notes" || id === "clean-room") id = `${id}-2`
          seen.add(id)
          planned.push({ id, name, source: spec })
        }
        // The configured whitelist is the ceiling: a plan may narrow it, never widen it.
        const allowed: readonly string[] = context.whitelist ?? DEFAULT_LICENSE_WHITELIST
        const requested: string[] = Array.isArray(input.whitelist) ? input.whitelist.map(String) : []
        const ignored = requested.filter((id) => !allowed.includes(id))
        const narrowed = requested.filter((id) => allowed.includes(id))
        const whitelist = requested.length ? narrowed : [...allowed]
        const plan = {
          version: 1 as const,
          objective,
          candidates: planned,
          readTokensPerCandidate: input.readTokensPerCandidate ? Number(input.readTokensPerCandidate) : 40_000,
          whitelist,
          createdAt: new Date().toISOString(),
        }
        await startHarvestRun(root, plan, run)
        return [
          `Darkharvest planned (run "${run}"): ${objective}`,
          `Candidates (${planned.length}): ${planned.map((item) => `${item.id} ← ${item.source}`).join(", ")}`,
          `Read budget: ${plan.readTokensPerCandidate} tokens per candidate · whitelist: ${whitelist.join(", ") || "(empty: nothing may be depended on or vendored)"}`,
          ...(ignored.length
            ? [`Ignored (not in the configured licence whitelist; a plan can only narrow it): ${ignored.join(", ")}`]
            : []),
          "",
          "Next steps:",
          "1. es_harvest_scan each candidate (profiles land under the run's directory).",
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
        const found = await discoverRepos(input, api()).catch((error: Error) => {
          throw new ToolRefusal(error.message)
        })
        const lines = found.repos.map(repoLine)
        return [
          `Discovery (${found.total} candidate(s); license fields are API claims, not verified):`,
          lines.length ? lines.join("\n") : "No results.",
          ...found.warnings,
          "Pick the list with the human, then es_harvest_plan with the chosen sources.",
        ].join("\n")
      },
    },
    {
      name: "es_harvest_scan",
      description:
        "Harvester only: clone or read a planned candidate, index it and detect its license (fail-closed). Writes the run's <id>/profile.json.",
      input: object(
        {
          candidate: { type: "string", description: "Candidate id from the plan." },
          run: { type: "string", description: "Plan run id from es_harvest_plan." },
        },
        ["candidate"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may scan candidates.")
        const run = runOf(input)
        const plan = await readHarvestPlan(root, run).catch((error: Error) => {
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
            ...sourcePolicy,
            ...(context.clone ? { clone: context.clone } : {}),
            ...(toolContext.signal ? { signal: toolContext.signal } : {}),
          })
        } catch (error) {
          throw new ToolRefusal(`Scan of "${id}" failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        await writeProfile(root, profile, run)
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
          run: { type: "string", description: "Plan run id from es_harvest_plan." },
        },
        ["candidate", "file"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may read candidates.")
        const run = runOf(input)
        const plan = await readHarvestPlan(root, run).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No darkharvest plan.")
        if (!(await readProfile(root, String(input.candidate), run)))
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
          run: { type: "string", description: "Plan run id from es_harvest_plan." },
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
        const run = runOf(input)
        const plan = await readHarvestPlan(root, run).catch((error: Error) => {
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
        const profiles = await withCurrentLicenses(root, await readProfiles(root, run))
        const missing = plan.candidates.filter((candidate) => !profiles.has(candidate.id))
        if (missing.length)
          throw new ToolRefusal(`Scan these candidates first: ${missing.map((item) => item.id).join(", ")}.`)
        const built = buildMatrix(
          plan.candidates.map((candidate) => candidate.id),
          profiles,
          rows,
          plan.whitelist,
        )
        await writeMatrix(root, built.matrix, run)
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
        run: { type: "string", description: "Plan run id from es_harvest_plan." },
      }),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "harvester")
          throw new ToolRefusal("Only the harvester seat may complete a darkharvest.")
        const run = runOf(input)
        const plan = await readHarvestPlan(root, run).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No darkharvest plan.")
        const profiles = await readProfiles(root, run)
        const scanned = new Set(profiles.map((profile) => profile.id))
        const missing = plan.candidates.filter((candidate) => !scanned.has(candidate.id))
        if (missing.length && input.allowPartial !== true)
          throw new ToolRefusal(
            `Candidates not scanned: ${missing.map((item) => item.id).join(", ")}. Scan them, or pass allowPartial:true to record them as gaps.`,
          )
        const stored = await readMatrix(root, run).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the matrix: ${error.message}`)
        })
        if (!stored) throw new ToolRefusal("No matrix yet. Build it with es_harvest_matrix first.")
        // Never trust verdicts or licences read back from disk: re-derive the
        // licences from the scanned bytes and re-apply the policy.
        const current = await withCurrentLicenses(root, profiles)
        const rechecked = recheckMatrix(stored, current, plan.whitelist)
        const matrix = rechecked.matrix
        if (rechecked.downgrades.length) await writeMatrix(root, matrix, run)
        const finalProfiles = [...current.values()]
        const rendered = renderHarvest(plan.objective, finalProfiles, matrix)
        await writeHarvestResult(root, plan.objective, finalProfiles, matrix, rendered, run)
        const counts = new Map<string, number>()
        for (const row of matrix.rows)
          for (const cell of row.cells) counts.set(cell.verdict, (counts.get(cell.verdict) ?? 0) + 1)
        const base = factoryLayout(root).dir
        return [
          `Darkharvest complete: ${profiles.length} profile(s), ${matrix.rows.length} feature(s)${missing.length ? `, ${missing.length} gap(s)` : ""}.`,
          ...(rechecked.downgrades.length
            ? [
                `${rechecked.downgrades.length} stored verdict(s) no longer passed the licence policy and were downgraded:`,
                ...rechecked.downgrades.map((item) => `- ${item.candidate} · ${item.feature}: ${item.reason}`),
              ]
            : []),
          `Verdicts: ${[...counts].map(([verdict, count]) => `${verdict} ${count}`).join(", ")}`,
          `Written: ${base}/harvest/runs/${run}/harvest.json, HARVEST.md, VENDOR-PLAN.md${rendered.cleanRoom.length ? ` and ${rendered.cleanRoom.length} clean-room spec(s)` : ""}`,
        ].join("\n")
      },
    },
    {
      name: "es_harvest_prior_art",
      description:
        "Harvester, brainstormer, grill or factory: find projects related to brainstorm ideas. You decide the relation (novel/similar/existing) and pass the result to es_brainstorm_complete.",
      input: object(
        {
          run: { type: "string", description: "Brainstorm run these searches belong to (keyed per run)." },
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
        if (!maySearchPriorArt(toolContext.agent))
          throw new ToolRefusal("Only the harvester, brainstormer, grill and factory seats may run prior-art checks.")
        const run = runOf(input)
        const ideas = Array.isArray(input.ideas) ? input.ideas : []
        if (!ideas.length) throw new ToolRefusal("Give at least one idea.")
        const limit = Math.min(Number(input.limit ?? 3) || 3, 10)
        const github = githubApi(api())
        const lines: string[] = []
        const searches: PriorArtSearch[] = []
        for (const idea of ideas) {
          const keywords = words(`${idea.title ?? ""} ${idea.text ?? ""}`)
            .slice(0, 6)
            .join(" ")
          if (!keywords) {
            lines.push(`- ${idea.id}: no keywords; relation "novel" by default`)
            continue
          }
          const query = `${keywords} in:name,description,readme`
          try {
            const results = await github.search(query, limit)
            searches.push({
              idea: String(idea.id),
              query,
              status: "ok",
              results: results.map((repo) => ({ title: repo.fullName ?? repo.name, url: repo.url })),
              searchedAt: new Date().toISOString(),
              run,
            })
            lines.push(
              `- ${idea.id} "${idea.title}" — ${results.length ? "related projects:" : "no related projects found (candidate for novel):"}`,
              ...results.map((repo) => `  · ${repo.fullName ?? repo.name} — ${repo.url}`),
            )
          } catch (error) {
            searches.push({
              idea: String(idea.id),
              query,
              status: "failed",
              results: [],
              searchedAt: new Date().toISOString(),
              run,
            })
            lines.push(
              `- ${idea.id}: prior-art search failed (${error instanceof Error ? error.message : String(error)}); UNVERIFIED — do not claim novelty`,
            )
          }
        }
        await recordPriorArt(root, searches)
        return [
          "Prior-art candidates (relations and novelty are your judgement; searches that failed are UNVERIFIED):",
          lines.join("\n"),
          'Record the result: pass priorArt:[{ title, url, relation: "novel"|"similar"|"existing", note }] to es_brainstorm_complete.',
        ].join("\n")
      },
    },
    {
      name: "es_harvest_target",
      description:
        "Grill, factory, scout or harvester: scan up to 5 sources for a license-and-verdict check (no subagent, no model calls). Fail-closed: unverified, copyleft, unknown or non-whitelisted licenses become clean-room. Returns the verdicts as JSON.",
      input: object(
        {
          objective: { type: "string", description: "What the verdicts are for." },
          targets: {
            type: "array",
            description:
              'Sources (at most 5): "github:owner/repo", "gitlab:group/project", "git:https://…", "npm:name", "local:./path".',
            items: { type: "string" },
          },
          proposed: {
            type: "string",
            enum: ["depend", "vendor"],
            description: "Verdict to check each target against (default depend).",
          },
          run: { type: "string", description: "Run id the profiles are written under." },
        },
        ["objective", "targets"],
      ),
      execute: async (input, toolContext) => {
        if (!mayTarget(toolContext.agent))
          throw new ToolRefusal("Only the grill, factory, scout and harvester seats may scan a harvest target.")
        const run = runOf(input)
        const objective = String(input.objective ?? "").trim()
        if (!objective) throw new ToolRefusal("Give the check an objective.")
        const targets = Array.isArray(input.targets) ? input.targets.map(String) : []
        if (!targets.length) throw new ToolRefusal("Give at least one target.")
        if (targets.length > 5) throw new ToolRefusal(`Give at most 5 targets per call (asked for ${targets.length}).`)
        const proposed = input.proposed === "vendor" ? "vendor" : "depend"
        const allowed: readonly string[] = context.whitelist ?? DEFAULT_LICENSE_WHITELIST
        const seen = new Set((await readProfiles(root, run)).map((profile) => profile.id))
        const verdicts: Array<{
          target: string
          license: { spdx: string; family: string; verified: boolean }
          verdict: string
          attribution?: string
          provenance: { origin: string; commit?: string; scannedAt: string }
        }> = []
        const lines = [`Target verdicts for "${objective}" (run "${run}", proposed ${proposed}):`]
        for (const spec of targets) {
          let source: HarvestSource
          try {
            source = parseSource(spec)
            assertSourceAllowed(root, source, sourcePolicy)
          } catch (error) {
            throw new ToolRefusal(error instanceof Error ? error.message : String(error))
          }
          const label =
            source.kind === "local"
              ? path.basename(canonicalPath(source.path, root)) || spec
              : source.kind === "git"
                ? (source.url.split("/").filter(Boolean).pop() ?? spec)
                : source.kind === "registry"
                  ? `${source.registry}:${source.name}`
                  : (source.repo.split("/").filter(Boolean).pop() ?? spec)
          let id = candidateId(label)
          while (seen.has(id) || id === "notes" || id === "clean-room" || id === "runs") id = `${id}-2`
          seen.add(id)
          let profile: HarvestProfile
          try {
            profile = await scanSource(root, id, source, {
              ...api(),
              ...sourcePolicy,
              ...(context.clone ? { clone: context.clone } : {}),
              ...(toolContext.signal ? { signal: toolContext.signal } : {}),
            })
          } catch (error) {
            throw new ToolRefusal(`Scan of "${spec}" failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          await writeProfile(root, profile, run)
          const checked = checkVerdict(proposed, profile.license, allowed)
          verdicts.push({
            target: spec,
            license: { spdx: profile.license.spdx, family: profile.license.family, verified: profile.license.verified },
            verdict: checked.verdict,
            ...(checked.attribution ? { attribution: checked.attribution } : {}),
            provenance: {
              origin: profile.origin ?? spec,
              ...(profile.commit ? { commit: profile.commit } : {}),
              scannedAt: profile.scannedAt,
            },
          })
          lines.push(
            `- ${spec} → ${checked.verdict} (license ${profile.license.spdx}, ${profile.license.family}${profile.license.verified ? ", verified" : ", UNVERIFIED"})${checked.downgraded ? ` — ${checked.downgraded}` : ""}`,
          )
        }
        return [...lines, "", "--- verdicts (JSON) ---", JSON.stringify(verdicts)].join("\n")
      },
    },
  ]
}
