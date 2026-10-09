// Harness-neutral brainstorm tools. The loop is mechanical where it matters:
// es_brainstorm_plan freezes the lens set and the caps, es_brainstorm_record
// refuses cap violations and collapses near-duplicates, es_brainstorm_score
// (critic only) records rubric scores, and es_brainstorm_complete refuses to
// finish while a lens has no ideas or an idea has no score. Seat checks keep
// the critic scoring and the brainstormer orchestrating.
import { seatOf } from "../agents/registry.ts"
import { priorArtUrls } from "../harvest/prior-art.ts"
import { factoryLayout } from "../layout.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { ToolRefusal } from "../ops/tools.ts"
import {
  BrainstormBriefSchema,
  type BrainstormIdea,
  BrainstormResultSchema,
  type BrainstormScore,
  BrainstormScoreSchema,
  RUBRIC,
} from "../schema/brainstorm.ts"
import { createEmbedder, type EmbeddingsConfig } from "./embed.ts"
import { collapseDuplicates, collapseDuplicatesEmbedded, rankIdeas, selectShortlist } from "./engine.ts"
import { buildPlan, LENSES, type PlanOptions } from "./lenses.ts"
import {
  DEFAULT_RUN,
  parseRunId,
  readIdeas,
  readPlan,
  readScores,
  renderBrainstorm,
  startRun,
  writeIdeas,
  writeResult,
  writeScores,
} from "./store.ts"

export interface BrainstormOpsContext {
  readonly root: string
  readonly embeddings?: EmbeddingsConfig
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const now = () => new Date().toISOString()
const list = (items: readonly string[], limit = 8) =>
  items.length > limit ? `${items.slice(0, limit).join(", ")} (+${items.length - limit} more)` : items.join(", ")

/**
 * Seats that may run a brainstorm: the brainstormer (human /brainstorm) and
 * the grill/factory seats, which fan out the lens subagents themselves at
 * depth 1 and record what comes back (#108). The critic only scores.
 */
const mayRun = (agent: string | undefined): boolean => {
  const seat = seatOf(agent)
  return seat === "brainstormer" || seat === "grill" || seat === "factory"
}
/** Spend guard (#108): callers other than the brainstormer get lean defaults unless they ask for more. */
const LEAN_LENSES = 4
const LEAN_IDEAS_PER_LENS = 3
const LEAN_SHORTLIST_SIZE = 5
const runRefusal = (verb: string) =>
  new ToolRefusal(`Only the brainstormer seat (or the grill/factory seats running a callable brainstorm) may ${verb}.`)
const runOf = (input: { run?: unknown }): string => {
  try {
    return parseRunId(input.run)
  } catch (error) {
    throw new ToolRefusal(error instanceof Error ? error.message : String(error))
  }
}

export function brainstormTools(context: BrainstormOpsContext): EsToolDef[] {
  const { root } = context
  const embed = context.embeddings ? createEmbedder(context.embeddings) : undefined
  const collapse = async (
    ideas: readonly BrainstormIdea[],
    mode: "ngram" | "minhash" | "embedding",
    threshold: number,
  ) => {
    if (mode === "embedding") {
      if (!embed) throw new ToolRefusal("This plan uses embedding dedupe but no embeddings endpoint is configured.")
      return collapseDuplicatesEmbedded(ideas, threshold, embed)
    }
    return collapseDuplicates(ideas, threshold, { mode })
  }

  return [
    {
      name: "es_brainstorm_plan",
      description:
        "Brainstormer, grill or factory: freeze the lens set, idea caps and shortlist size for a brainstorm run. Returns the run id and the subagents to launch (launch every lens in one message, in the foreground).",
      input: object(
        {
          idea: { type: "string", description: "The brief in one or two sentences." },
          context: { type: "string", description: "Optional background that every lens should see." },
          constraints: { type: "array", items: { type: "string" } },
          run: {
            type: "string",
            description: `Run id for this brainstorm (lowercase/dashes; default "${DEFAULT_RUN}"). Several runs can coexist.`,
          },
          lenses: {
            type: "array",
            items: { type: "string" },
            description: `Lens ids to run (default ${LENSES.slice(0, 6).length}: ${LENSES.slice(0, 6)
              .map((lens) => lens.id)
              .join(", ")}). Built-ins: ${LENSES.map((lens) => lens.id).join(", ")}`,
          },
          ideasPerLens: { type: "number", description: "Ideas per lens (1-10, default 5)." },
          shortlistSize: {
            type: "number",
            description: "Shortlist size including the forced outlier (2-12, default 7).",
          },
          dedupe: {
            type: "string",
            enum: ["ngram", "minhash", "embedding"],
            description: "Dedupe similarity: n-gram, MinHash (default), or embeddings when configured.",
          },
          force: { type: "boolean", description: "Replace an in-progress brainstorm." },
        },
        ["idea"],
      ),
      execute: async (input, toolContext) => {
        if (!mayRun(toolContext.agent)) throw runRefusal("plan a brainstorm")
        const run = runOf(input)
        const lean = seatOf(toolContext.agent) !== "brainstormer"
        const brief = BrainstormBriefSchema.parse({
          idea: String(input.idea ?? "").trim(),
          ...(input.context ? { context: String(input.context) } : {}),
          ...(Array.isArray(input.constraints) ? { constraints: input.constraints.map(String) } : {}),
        })
        const existing = await readPlan(root, run).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the current plan: ${error.message}`)
        })
        const ideas = existing ? await readIdeas(root, run) : []
        if (existing && ideas.length && input.force !== true)
          throw new ToolRefusal(
            `A brainstorm is already in progress (${ideas.length} idea(s) recorded). Pass force:true to replace it, or finish it with es_brainstorm_complete.`,
          )
        let built: ReturnType<typeof buildPlan>
        try {
          built = buildPlan(brief, {
            ...(Array.isArray(input.lenses)
              ? { lenses: input.lenses.map(String) }
              : lean
                ? { lenses: LENSES.slice(0, LEAN_LENSES).map((lens) => lens.id) }
                : {}),
            ...(input.ideasPerLens !== undefined
              ? { ideasPerLens: Number(input.ideasPerLens) }
              : lean
                ? { ideasPerLens: LEAN_IDEAS_PER_LENS }
                : {}),
            ...(input.shortlistSize !== undefined
              ? { shortlistSize: Number(input.shortlistSize) }
              : lean
                ? { shortlistSize: LEAN_SHORTLIST_SIZE }
                : {}),
            ...(input.dedupe ? { dedupeMode: String(input.dedupe) as "ngram" | "minhash" | "embedding" } : {}),
          } satisfies PlanOptions)
        } catch (error) {
          throw new ToolRefusal(error instanceof Error ? error.message : String(error))
        }
        await startRun(root, built.plan, run)
        const ids = built.lenses.map((lens) => `es-lens-${lens.id}`)
        return [
          `Brainstorm planned (run "${run}"): "${built.plan.brief.idea}"`,
          `Lenses (${built.lenses.length}): ${built.lenses.map((lens) => `${lens.id} (${lens.name})`).join(", ")}`,
          `Caps: ≤${built.plan.ideasPerLens} ideas per lens, ≤${built.plan.maxIdeaChars} characters each; shortlist ${built.plan.shortlistSize}.`,
          "",
          "Next steps:",
          `1. Launch every lens subagent in parallel by exact ID: ${ids.join(", ")}.`,
          "   Give each one the brief (and constraints) plus how many ideas you expect.",
          `2. Record each lens's ideas with es_brainstorm_record (one call per lens, run "${run}").`,
          "3. Launch es-brainstorm-critic with the surviving idea ids and texts; it scores each with es_brainstorm_score.",
          `4. Call es_brainstorm_complete with run "${run}". Dedupe, ranking and the shortlist (with one forced outlier) are computed there.`,
          "",
          `Rubric (1-5 each): ${RUBRIC.map((item) => item.id).join(", ")}.`,
        ].join("\n")
      },
    },
    {
      name: "es_brainstorm_record",
      description:
        "Brainstormer, grill or factory: record one lens's ideas for a run. Rejects caps violations, near-duplicates are collapsed against earlier ideas.",
      input: object(
        {
          lens: { type: "string" },
          run: { type: "string", description: "Run id from es_brainstorm_plan." },
          ideas: {
            type: "array",
            items: object({
              title: { type: "string" },
              text: { type: "string" },
              notes: { type: "string" },
            }),
          },
        },
        ["lens", "ideas"],
      ),
      execute: async (input, toolContext) => {
        if (!mayRun(toolContext.agent)) throw runRefusal("record ideas for a brainstorm")
        const run = runOf(input)
        const plan = await readPlan(root, run).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No brainstorm plan. Call es_brainstorm_plan first.")
        const lens = String(input.lens ?? "")
        if (!plan.lenses.includes(lens))
          throw new ToolRefusal(`"${lens}" is not in this plan. Planned lenses: ${plan.lenses.join(", ")}.`)
        const batch = Array.isArray(input.ideas) ? input.ideas : []
        if (!batch.length) throw new ToolRefusal("Give at least one idea.")
        const existing = await readIdeas(root, run)
        const used = existing.filter((idea) => idea.lens === lens).length
        if (used + batch.length > plan.ideasPerLens)
          throw new ToolRefusal(
            `The "${lens}" lens already has ${used} idea(s); recording ${batch.length} more exceeds the cap of ${plan.ideasPerLens}.`,
          )
        let seq = existing.reduce((max, idea) => Math.max(max, Number.parseInt(idea.id.replace(/^b/, ""), 10) || 0), 0)
        const recorded: BrainstormIdea[] = []
        for (const [index, raw] of batch.entries()) {
          const title = String(raw?.title ?? "").trim()
          const text = String(raw?.text ?? "").trim()
          if (title.length < 3) throw new ToolRefusal(`Idea ${index + 1}: title is too short.`)
          if (title.length > 200) throw new ToolRefusal(`Idea ${index + 1}: title is too long (200 characters).`)
          if (text.length < 40) throw new ToolRefusal(`Idea ${index + 1}: text is too short; explain the idea.`)
          if (text.length > plan.maxIdeaChars)
            throw new ToolRefusal(`Idea ${index + 1}: text exceeds ${plan.maxIdeaChars} characters.`)
          seq += 1
          recorded.push({
            id: `b${String(seq).padStart(3, "0")}`,
            lens,
            title,
            text,
            ...(raw?.notes ? { notes: String(raw.notes) } : {}),
            recordedAt: now(),
          })
        }
        const all = [...existing, ...recorded]
        const hits = await collapse(all, plan.dedupeMode, plan.dedupeThreshold)
        const byId = new Map(hits.map((hit) => [hit.id, hit]))
        const stored = all.map((idea) => {
          const hit = byId.get(idea.id)
          return hit ? { ...idea, duplicateOf: hit.duplicateOf, similarity: hit.similarity } : idea
        })
        await writeIdeas(root, stored, run)
        const lines = [
          `Recorded ${recorded.length} idea(s) for "${lens}" (${used + recorded.length}/${plan.ideasPerLens}): ${recorded.map((idea) => idea.id).join(", ")}`,
        ]
        const dropped = recorded.map((idea) => byId.get(idea.id)).filter((hit) => hit !== undefined)
        for (const hit of dropped)
          lines.push(
            `- ${hit.id} duplicates ${hit.duplicateOf} (similarity ${hit.similarity}); it will be collapsed at completion.`,
          )
        const remainingLenses = plan.lenses.filter((id) => id !== lens && !stored.some((idea) => idea.lens === id))
        if (remainingLenses.length) lines.push(`Lenses still without ideas: ${remainingLenses.join(", ")}.`)
        const total = stored.filter((idea) => !idea.duplicateOf).length
        lines.push(`Surviving ideas so far: ${total}.`)
        return lines.join("\n")
      },
    },
    {
      name: "es_brainstorm_score",
      description:
        "Critic only: score ideas 1-5 on novelty, upside, feasibility and fit. Re-scoring an id replaces its scores.",
      input: object(
        {
          run: { type: "string", description: "Run id from es_brainstorm_plan." },
          scores: {
            type: "array",
            items: object(
              {
                id: { type: "string" },
                novelty: { type: "number" },
                upside: { type: "number" },
                feasibility: { type: "number" },
                fit: { type: "number" },
                note: { type: "string" },
              },
              ["id", "novelty", "upside", "feasibility", "fit"],
            ),
          },
        },
        ["scores"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "brainstorm-critic")
          throw new ToolRefusal("Only the brainstorm-critic seat may score ideas.")
        const run = runOf(input)
        const plan = await readPlan(root, run).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No brainstorm plan to score against.")
        const ideas = await readIdeas(root, run)
        const scores = await readScores(root, run)
        const byId = new Map(ideas.map((idea) => [idea.id, idea]))
        const batch = Array.isArray(input.scores) ? input.scores : []
        if (!batch.length) throw new ToolRefusal("Give at least one score.")
        const incoming: BrainstormScore[] = []
        for (const raw of batch) {
          const id = String(raw?.id ?? "")
          const idea = byId.get(id)
          if (!idea) throw new ToolRefusal(`Unknown idea id "${id}".`)
          if (idea.duplicateOf)
            throw new ToolRefusal(`"${id}" is a duplicate of ${idea.duplicateOf}; do not score duplicates.`)
          const parsed = BrainstormScoreSchema.safeParse({
            id,
            novelty: Number(raw?.novelty),
            upside: Number(raw?.upside),
            feasibility: Number(raw?.feasibility),
            fit: Number(raw?.fit),
            ...(raw?.note ? { note: String(raw.note) } : {}),
            scoredAt: now(),
          })
          if (!parsed.success) throw new ToolRefusal(`Score for "${id}" is invalid: each criterion is an integer 1-5.`)
          incoming.push(parsed.data)
        }
        const merged = new Map(scores.map((score) => [score.id, score]))
        for (const score of incoming) merged.set(score.id, score)
        await writeScores(root, [...merged.values()], run)
        const survivors = ideas.filter((idea) => !idea.duplicateOf)
        const missing = survivors.filter((idea) => !merged.has(idea.id))
        return [
          `Scored: ${incoming.map((score) => `${score.id} (${score.novelty + score.upside + score.feasibility + score.fit}/20)`).join(", ")}`,
          `Scored ${survivors.length - missing.length}/${survivors.length} surviving ideas.`,
          missing.length
            ? `Still unscored: ${list(missing.map((idea) => idea.id))}.`
            : "All surviving ideas are scored; call es_brainstorm_complete.",
        ].join("\n")
      },
    },
    {
      name: "es_brainstorm_complete",
      description:
        "Brainstormer, grill or factory: collapse duplicates, rank the scored ideas and write the diversified shortlist with a forced outlier slot. Returns the shortlist as JSON the caller can parse.",
      input: object({
        run: { type: "string", description: "Run id from es_brainstorm_plan." },
        allowPartial: {
          type: "boolean",
          description: "Finish even when a planned lens produced no surviving idea (they are recorded as gaps).",
        },
        priorArt: {
          type: "array",
          description: "Optional prior-art check results (from harvest).",
          items: object(
            {
              title: { type: "string" },
              url: { type: "string" },
              relation: { type: "string", enum: ["novel", "similar", "existing"] },
              note: { type: "string" },
            },
            ["title", "url", "relation"],
          ),
        },
      }),
      execute: async (input, toolContext) => {
        if (!mayRun(toolContext.agent)) throw runRefusal("complete a brainstorm")
        const run = runOf(input)
        const plan = await readPlan(root, run).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No brainstorm plan. Call es_brainstorm_plan first.")
        const ideas = await readIdeas(root, run)
        if (!ideas.length) throw new ToolRefusal("No ideas recorded yet.")
        const hits = await collapse(ideas, plan.dedupeMode, plan.dedupeThreshold)
        const hitById = new Map(hits.map((hit) => [hit.id, hit]))
        const survivors = ideas.filter((idea) => !hitById.has(idea.id))
        const coverage: Record<string, number> = {}
        for (const lens of plan.lenses) coverage[lens] = survivors.filter((idea) => idea.lens === lens).length
        const gaps = plan.lenses.filter((lens) => coverage[lens] === 0)
        if (gaps.length && input.allowPartial !== true)
          throw new ToolRefusal(
            `These planned lenses produced no surviving idea: ${gaps.join(", ")}. Record ideas for them, or pass allowPartial:true to finish with gaps.`,
          )
        const scores = new Map((await readScores(root, run)).map((score) => [score.id, score]))
        const unscored = survivors.filter((idea) => !scores.has(idea.id))
        if (unscored.length)
          throw new ToolRefusal(
            `Still unscored: ${list(unscored.map((idea) => idea.id))}. Have es-brainstorm-critic score them (es_brainstorm_score) first.`,
          )
        // Prior art must come from a recorded es_harvest_prior_art search, not from memory.
        const priorArt = Array.isArray(input.priorArt) ? input.priorArt : []
        if (priorArt.length) {
          const found = await priorArtUrls(root)
          const unrecorded = priorArt.filter((entry: { url?: unknown }) => !found.has(String(entry?.url ?? "")))
          if (unrecorded.length)
            throw new ToolRefusal(
              `Prior art must come from es_harvest_prior_art results; not found by any recorded search: ${list(unrecorded.map((entry: { url?: unknown }) => String(entry?.url ?? "")))}.`,
            )
        }
        const ranked = rankIdeas(survivors, scores)
        const texts = new Map(survivors.map((idea) => [idea.id, `${idea.title}. ${idea.text}`]))
        const shortlist = selectShortlist(ranked, texts, plan.shortlistSize)
        const result = BrainstormResultSchema.parse({
          version: plan.version,
          brief: plan.brief,
          lenses: plan.lenses,
          ideas: survivors,
          duplicates: hits.map((hit) => {
            const idea = ideas.find((item) => item.id === hit.id)!
            return {
              id: hit.id,
              duplicateOf: hit.duplicateOf,
              similarity: hit.similarity,
              lens: idea.lens,
              title: idea.title,
            }
          }),
          ranked,
          shortlist,
          coverage,
          gaps,
          ...(priorArt.length ? { priorArt } : {}),
          stats: {
            lenses: plan.lenses.length,
            ideas: survivors.length,
            duplicates: hits.length,
            scored: survivors.length,
          },
          completedAt: now(),
        })
        await writeResult(root, result, renderBrainstorm(result), run)
        const byId = new Map(survivors.map((item) => [item.id, item]))
        const short = shortlist
          .map((entry, index) => {
            const item = byId.get(entry.id)!
            return `${index + 1}. ${entry.id} (${entry.total}/20)${entry.outlier ? " · outlier" : ""} — ${item.title}`
          })
          .join("\n")
        const shortlistJson = JSON.stringify({
          run,
          shortlist: shortlist.map((entry) => {
            const item = byId.get(entry.id)!
            return {
              id: entry.id,
              title: item.title,
              lens: item.lens,
              total: entry.total,
              outlier: entry.outlier,
              ...(entry.reason ? { reason: entry.reason } : {}),
            }
          }),
        })
        return [
          `Brainstorm complete (run "${run}"): ${survivors.length} ideas, ${hits.length} duplicate(s) collapsed, ${plan.lenses.length} lenses.`,
          `Shortlist (${shortlist.length}):`,
          short,
          `Written: ${factoryLayout(root).dir}/brainstorm/runs/${run}/brainstorm.json and BRAINSTORM.md`,
          "",
          "--- shortlist (JSON) ---",
          shortlistJson,
        ].join("\n")
      },
    },
  ]
}
