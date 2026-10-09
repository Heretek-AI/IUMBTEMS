// Harness-neutral OSS-scout tools (scout seat only): plan, discover, scan
// (darkharvest's scanner, fail-closed license), advisories (OSV, cached),
// record (one witnessed assessment per candidate) and complete (core
// recomputes every verdict, ranks, writes the dossier and REPORT.md).
import { seatOf } from "../agents/registry.ts"
import { ClaimError, type ClaimInput, normalizeClaim } from "../claims/claim.ts"
import { buildDossier, writeDossier } from "../claims/dossier.ts"
import { witnessClaim } from "../claims/witness.ts"
import { assertSourceAllowed, candidateId, parseSource, scanSource } from "../harvest/scan.ts"
import { discoverRepos, repoLine } from "../harvest/sources.ts"
import { stateDir as defaultStateDir } from "../layout.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { ToolRefusal } from "../ops/tools.ts"
import { researchCache } from "../research/ops.ts"
import { OSV_ECOSYSTEMS, type OsvEcosystem, queryOsv } from "../research/osv.ts"
import type { Claim } from "../schema/claims.ts"
import { DEFAULT_LICENSE_WHITELIST, type HarvestProfile } from "../schema/harvest.ts"
import { SCOUT_VERSION, type ScoutAdvisory, type ScoutAssessment, ScoutAssessmentSchema } from "../schema/scout.ts"
import { relativeTo } from "../trust/paths.ts"
import { atomicWrite } from "../util/fs.ts"
import { renderScoutReport } from "./report.ts"
import {
  readAssessments,
  readScoutAdvisories,
  readScoutPlan,
  readScoutProfile,
  scoutPaths,
  startScoutRun,
  upsertAssessment,
  writeScoutAdvisories,
  writeScoutProfile,
  writeScoutResult,
} from "./store.ts"
import { type CandidateEvidence, scoutVerdicts } from "./verdict.ts"

export interface ScoutOpsContext {
  readonly root: string
  readonly fetch?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
  readonly clone?: (url: string, dir: string) => Promise<unknown>
  /** SPDX ids that may be adopted (config licenseWhitelist); a plan may only narrow it. */
  readonly whitelist?: readonly string[]
  /** The user-global state dir agents may never scan (default: stateDir()).
   *  It also holds the engine key that seals the source cache (#98). */
  readonly stateDir?: string
  /** The reason the factory run is halted, if it is (STOP is enforced by the host). */
  readonly halted?: () => Promise<string | undefined>
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const CLAIM_INPUT = object(
  {
    tag: { type: "string", enum: ["VERIFIED", "INFERRED", "HYPOTHESIS", "NEGATIVE_KNOWLEDGE"] },
    statement: { type: "string" },
    source: object({ sha256: { type: "string" }, quote: { type: "string" } }, ["sha256", "quote"]),
    reasoning: { type: "string" },
    falsification: { type: "string" },
    query: { type: "string" },
    finding: { type: "string" },
  },
  ["tag", "statement"],
)

/** Advisory facts as claims citing the cached OSV response (tool-generated, never agent-asserted). */
export function advisoryClaims(name: string, advisories: readonly ScoutAdvisory[]): Claim[] {
  return advisories
    .filter((advisory) => advisory.source)
    .map((advisory) =>
      normalizeClaim({
        tag: "VERIFIED",
        statement: `${advisory.id} (${advisory.severity ?? "unrated"}) affects ${name}: ${advisory.summary || "see the advisory"}`,
        source: {
          sha256: advisory.source!,
          quote: `${advisory.id}${advisory.aliases?.length ? ` (${advisory.aliases.join(", ")})` : ""} severity ${advisory.severity ?? "unrated"}`,
        },
      }),
    )
}

export function scoutTools(context: ScoutOpsContext): EsToolDef[] {
  const { root } = context
  const cache = researchCache(root, context.stateDir ?? defaultStateDir())
  const sourcePolicy = { ...(context.stateDir ? { stateDir: context.stateDir } : {}) }
  const api = () => ({
    ...(context.fetch ? { fetch: context.fetch } : {}),
    ...(context.env ? { env: context.env } : {}),
  })
  const guard = async (agent: string) => {
    if (seatOf(agent) !== "scout") throw new ToolRefusal("Only the scout seat may use the scout tools.")
    const halted = await context.halted?.()
    if (halted) throw new ToolRefusal(`The factory run is halted (${halted}); a human must resume it.`)
  }
  const plan = async () => {
    const current = await readScoutPlan(root).catch((error: Error) => {
      throw new ToolRefusal(`Cannot read the scout plan: ${error.message}`)
    })
    if (!current) throw new ToolRefusal("No scout plan. Call es_scout_plan first.")
    return current
  }
  const candidateOf = async (raw: unknown) => {
    const current = await plan()
    const id = String(raw ?? "")
    const candidate = current.candidates.find((item) => item.id === id)
    if (!candidate)
      throw new ToolRefusal(
        `Unknown candidate "${id}". Planned: ${current.candidates.map((item) => item.id).join(", ")}.`,
      )
    return { plan: current, candidate }
  }

  return [
    {
      name: "es_scout_plan",
      description:
        "Scout only: freeze the objective (the feature to adopt or rebuild), our license posture, the candidates and the adoptable-license whitelist (it may only narrow the configured one). Replaces any previous scout.",
      input: object(
        {
          objective: { type: "string" },
          posture: { type: "string", description: 'Our own license and use, e.g. "Apache-2.0, commercial SaaS"' },
          candidates: {
            type: "array",
            description:
              'Sources: "github:owner/repo", "gitlab:group/project", "git:https://…", "npm:name", "pypi:name", "crates:name", "local:./path".',
            items: object({ name: { type: "string" }, source: { type: "string" } }, ["name", "source"]),
          },
          whitelist: { type: "array", items: { type: "string" } },
        },
        ["objective", "candidates"],
      ),
      execute: async (input, toolContext) => {
        await guard(toolContext.agent)
        const objective = String(input.objective ?? "").trim()
        if (!objective) throw new ToolRefusal("Give the scout an objective.")
        const raw = Array.isArray(input.candidates) ? input.candidates : []
        if (!raw.length) throw new ToolRefusal("Give at least one candidate.")
        const seen = new Set<string>()
        const candidates = raw.map((item: any) => {
          const name = String(item?.name ?? "").trim()
          const spec = String(item?.source ?? "").trim()
          if (!name || !spec) throw new ToolRefusal("Every candidate needs a name and a source.")
          try {
            assertSourceAllowed(root, parseSource(spec), sourcePolicy)
          } catch (error) {
            throw new ToolRefusal(error instanceof Error ? error.message : String(error))
          }
          let id = candidateId(name)
          while (seen.has(id) || id === "notes") id = `${id}-2`
          seen.add(id)
          return { id, name, source: spec }
        })
        const allowed: readonly string[] = context.whitelist ?? DEFAULT_LICENSE_WHITELIST
        const requested: string[] = Array.isArray(input.whitelist) ? input.whitelist.map(String) : []
        const whitelist = requested.length ? requested.filter((id) => allowed.includes(id)) : [...allowed]
        const ignored = requested.filter((id) => !allowed.includes(id))
        await startScoutRun(root, {
          version: SCOUT_VERSION,
          objective,
          ...(input.posture ? { posture: String(input.posture) } : {}),
          candidates,
          whitelist,
          createdAt: new Date().toISOString(),
        })
        return [
          `Scout planned: ${objective}`,
          `Candidates (${candidates.length}): ${candidates.map((item: { id: string; source: string }) => `${item.id} ← ${item.source}`).join(", ")}`,
          `Adoptable licenses: ${whitelist.join(", ") || "(none: everything is clean-room)"}`,
          ...(ignored.length
            ? [`Ignored (a plan can only narrow the configured whitelist): ${ignored.join(", ")}`]
            : []),
          "Next: es_scout_scan each candidate, gather evidence (es_research_search/fetch), es_scout_advisories, es_scout_record, then es_scout_complete.",
        ].join("\n")
      },
    },
    {
      name: "es_scout_discover",
      description:
        "Scout only: search GitHub (and GitLab) for candidates by query, topic or dependency overlap. Results are claims to rerank, not evidence; the human edits the list.",
      input: object({
        queries: { type: "array", items: { type: "string" } },
        topics: { type: "array", items: { type: "string" } },
        dependencies: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        gitlab: { type: "boolean" },
      }),
      execute: async (input, toolContext) => {
        await guard(toolContext.agent)
        const found = await discoverRepos(input, api()).catch((error: Error) => {
          throw new ToolRefusal(error.message)
        })
        return [
          `Discovery (${found.total} candidate(s); stars and licenses are API claims, not verified):`,
          found.repos.length ? found.repos.map(repoLine).join("\n") : "No results.",
          ...found.warnings,
          "Pick the list with the human, then es_scout_plan with the chosen sources.",
        ].join("\n")
      },
    },
    {
      name: "es_scout_scan",
      description:
        "Scout only: clone or read a planned candidate, measure it (files, direct dependencies) and detect its license from the license text (fail-closed). Writes .factory/scout/<id>/profile.json.",
      input: object({ candidate: { type: "string" } }, ["candidate"]),
      execute: async (input, toolContext) => {
        await guard(toolContext.agent)
        const { candidate } = await candidateOf(input.candidate)
        let profile: HarvestProfile
        try {
          profile = await scanSource(root, candidate.id, parseSource(candidate.source), {
            ...api(),
            ...sourcePolicy,
            ...(context.clone ? { clone: context.clone } : {}),
            ...(toolContext.signal ? { signal: toolContext.signal } : {}),
          })
        } catch (error) {
          throw new ToolRefusal(
            `Scan of "${candidate.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        await writeScoutProfile(root, profile)
        return [
          `Scanned ${candidate.id}: ${profile.name}${profile.release ? ` ${profile.release}` : ""}`,
          `License: ${profile.license.spdx} (${profile.license.family}, ${profile.license.source}, ${profile.license.verified ? "verified from the text" : "UNVERIFIED"})`,
          `Size: ${profile.size.files} files, ~${profile.size.tokens} tokens · direct dependencies ${profile.dependencies.runtime.length}`,
          ...profile.warnings.map((warning) => `⚠ ${warning}`),
        ].join("\n")
      },
    },
    {
      name: "es_scout_advisories",
      description:
        'Scout only: query OSV.dev for a candidate\'s security advisories and cache the response (cite it as [VERIFIED: sha256:… "…"]). Registry candidates are looked up by name; for repositories give the package ecosystem and name.',
      input: object(
        {
          candidate: { type: "string" },
          ecosystem: { type: "string", enum: Object.values(OSV_ECOSYSTEMS) },
          package: { type: "string" },
          version: { type: "string" },
        },
        ["candidate"],
      ),
      execute: async (input, toolContext) => {
        await guard(toolContext.agent)
        const { candidate } = await candidateOf(input.candidate)
        const source = parseSource(candidate.source)
        const profile = await readScoutProfile(root, candidate.id).catch(() => undefined)
        const ecosystem = (input.ecosystem ??
          (source.kind === "registry" ? OSV_ECOSYSTEMS[source.registry] : undefined)) as OsvEcosystem | undefined
        const name = input.package ?? (source.kind === "registry" ? source.name : undefined)
        if (!ecosystem || !name)
          throw new ToolRefusal(
            `${candidate.id} is not a registry package: give the ecosystem (${Object.values(OSV_ECOSYSTEMS).join(", ")}) and the package name it publishes.`,
          )
        const version = input.version ?? profile?.release
        const result = await queryOsv(
          { ecosystem, name: String(name), ...(version ? { version: String(version) } : {}) },
          cache,
          {
            ...(context.fetch ? { fetch: context.fetch } : {}),
            ...(toolContext.signal ? { signal: toolContext.signal } : {}),
          },
        ).catch((error: Error) => {
          throw new ToolRefusal(`OSV query failed: ${error.message}`)
        })
        const advisories: ScoutAdvisory[] = result.advisories.map((advisory) => ({
          id: advisory.id,
          summary: advisory.summary,
          aliases: [...advisory.aliases],
          ...(advisory.severity ? { severity: advisory.severity } : {}),
          fixed: [...advisory.fixed],
          source: result.sha256,
        }))
        await writeScoutAdvisories(root, candidate.id, advisories)
        return [
          `${advisories.length} OSV advisor${advisories.length === 1 ? "y" : "ies"} for ${ecosystem}:${name}${version ? `@${version}` : ""}, cached as sha256:${result.sha256}.`,
          ...advisories.map(
            (advisory) =>
              `- ${advisory.id} ${advisory.severity ?? "unrated"}${advisory.fixed.length ? `, fixed in ${advisory.fixed.join(", ")}` : ", no fixed release"}: ${advisory.summary}`,
          ),
          advisories.length ? "" : `Record it as [NEGATIVE_KNOWLEDGE: OSV advisories for ${name}] if it matters.`,
        ]
          .filter(Boolean)
          .join("\n")
      },
    },
    {
      name: "es_scout_record",
      description:
        "Scout only: record one candidate's assessment: the discovery axes, the red-team, your proposal (adopt|clean-room|reject) with its rationale, a clean-room blueprint when rebuilding, and tagged claims. Every claim is witnessed (VERIFIED quotes against the cache); any failure refuses the record.",
      input: object(
        {
          candidate: { type: "string" },
          stars: { type: "number" },
          lastRelease: { type: "string" },
          releasesPerYear: { type: "number" },
          maintenance: { type: "string", enum: ["vibrant", "stable", "slow", "abandoned"] },
          proposal: { type: "string", enum: ["adopt", "clean-room", "reject"] },
          rationale: { type: "string" },
          blueprint: { type: "string" },
          claims: { type: "array", items: CLAIM_INPUT },
        },
        ["candidate", "maintenance", "proposal", "rationale", "claims"],
      ),
      execute: async (input, toolContext) => {
        await guard(toolContext.agent)
        const { candidate } = await candidateOf(input.candidate)
        const claims: Claim[] = []
        for (const raw of Array.isArray(input.claims) ? (input.claims as ClaimInput[]) : []) {
          try {
            claims.push(normalizeClaim(raw.tag === "NEGATIVE_KNOWLEDGE" ? { ...raw, kind: "negative_knowledge" } : raw))
          } catch (error) {
            throw new ToolRefusal(
              `Malformed claim "${String(raw?.statement ?? "").slice(0, 60)}": ${error instanceof ClaimError ? error.message : String(error)}`,
            )
          }
        }
        const known = new Set(claims.map((claim) => claim.id))
        const failures: string[] = []
        const witnessed: Claim[] = []
        for (const claim of claims) {
          const witness = await witnessClaim(claim, { cache, known })
          if (!witness.ok) failures.push(`- ${claim.statement.slice(0, 90)} — ${witness.reason}`)
          witnessed.push({ ...claim, witness })
        }
        if (failures.length)
          throw new ToolRefusal(
            `Refused: ${failures.length} claim(s) failed their witness check; nothing was recorded.\n${failures.join("\n")}`,
          )
        const assessment: ScoutAssessment = ScoutAssessmentSchema.parse({
          candidate: candidate.id,
          ...(input.stars !== undefined ? { stars: Number(input.stars) } : {}),
          ...(input.lastRelease ? { lastRelease: String(input.lastRelease) } : {}),
          ...(input.releasesPerYear !== undefined ? { releasesPerYear: Number(input.releasesPerYear) } : {}),
          maintenance: input.maintenance,
          advisories: (await readScoutAdvisories(root, candidate.id).catch(() => undefined)) ?? [],
          proposal: input.proposal,
          rationale: String(input.rationale ?? ""),
          ...(input.blueprint ? { blueprint: String(input.blueprint) } : {}),
          claims: witnessed,
          recordedAt: new Date().toISOString(),
        })
        await upsertAssessment(root, assessment)
        return `Recorded ${candidate.id}: proposal ${assessment.proposal} with ${witnessed.length} witnessed claim(s). The final verdict is computed by es_scout_complete from the verified license.`
      },
    },
    {
      name: "es_scout_complete",
      description:
        "Scout only: when every candidate is scanned and recorded, recompute the verdicts (adopt survives only for a verified, whitelisted, permissive license), flag severe advisories, rank, and write .factory/scout/REPORT.md, scout.json and dossier.json.",
      input: object({}),
      execute: async (_input, toolContext) => {
        await guard(toolContext.agent)
        const current = await plan()
        const assessments = new Map((await readAssessments(root)).map((item) => [item.candidate, item]))
        const profiles = new Map<string, HarvestProfile>()
        const evidence: CandidateEvidence[] = []
        const missing: string[] = []
        for (const candidate of current.candidates) {
          const profile = await readScoutProfile(root, candidate.id).catch(() => undefined)
          const assessment = assessments.get(candidate.id)
          if (!profile) missing.push(`${candidate.id}: scan it (es_scout_scan)`)
          if (!assessment) missing.push(`${candidate.id}: record it (es_scout_record)`)
          if (!profile || !assessment) continue
          profiles.set(candidate.id, profile)
          const advisories = (await readScoutAdvisories(root, candidate.id).catch(() => undefined)) ?? []
          evidence.push({
            id: candidate.id,
            name: candidate.name,
            profile,
            assessment,
            advisories,
            claims: [...assessment.claims, ...advisoryClaims(candidate.name, advisories)],
          })
        }
        if (missing.length) throw new ToolRefusal(`Not complete:\n- ${missing.join("\n- ")}`)
        const { verdicts } = scoutVerdicts(current, evidence)
        const result = {
          version: SCOUT_VERSION,
          objective: current.objective,
          verdicts,
          completedAt: new Date().toISOString(),
        }
        const paths = scoutPaths(root)
        await writeDossier(
          paths.dossier,
          buildDossier({
            mode: "oss-scout",
            subject: current.objective,
            claims: evidence.flatMap((item) => item.claims),
          }),
          { cache },
        ).catch((error: Error) => {
          throw new ToolRefusal(`The scout dossier could not be written: ${error.message}`)
        })
        await writeScoutResult(root, result)
        await atomicWrite(paths.report, renderScoutReport(current, result, profiles, assessments))
        return [
          `Scout complete: ${current.objective}`,
          ...verdicts.map(
            (verdict) =>
              `${verdict.rank}. ${verdict.name}: ${verdict.verdict}${verdict.proposal !== verdict.verdict ? ` (proposed ${verdict.proposal}; ${verdict.downgraded})` : ""}${verdict.warnings.length ? ` ⚠ ${verdict.warnings.join("; ")}` : ""}`,
          ),
          `Report: ${relativeTo(root, paths.report)}. Adoption is the human's decision.`,
        ].join("\n")
      },
    },
  ]
}
