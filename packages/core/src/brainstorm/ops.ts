// Harness-neutral brainstorm tools. The loop is mechanical where it matters:
// es_brainstorm_plan freezes the lens set and the caps, es_brainstorm_record
// refuses cap violations and collapses near-duplicates, es_brainstorm_score
// (critic only) records rubric scores, and es_brainstorm_complete refuses to
// finish while a lens has no ideas or an idea has no score. Seat checks keep
// the critic scoring and the brainstormer orchestrating.
import { seatOf } from "../agents/registry.ts"
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
import { collapseDuplicates, rankIdeas, selectShortlist } from "./engine.ts"
import { buildPlan, LENSES, type PlanOptions } from "./lenses.ts"
import {
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

export function brainstormTools(context: BrainstormOpsContext): EsToolDef[] {
  const { root } = context

  return [
    {
      name: "es_brainstorm_plan",
      description:
        "Brainstormer only: freeze the lens set, idea caps and shortlist size for a new brainstorm. Returns the subagents to launch.",
      input: object(
        {
          idea: { type: "string", description: "The brief in one or two sentences." },
          context: { type: "string", description: "Optional background that every lens should see." },
          constraints: { type: "array", items: { type: "string" } },
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
          force: { type: "boolean", description: "Replace an in-progress brainstorm." },
        },
        ["idea"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "brainstormer")
          throw new ToolRefusal("Only the brainstormer seat may plan a brainstorm.")
        const brief = BrainstormBriefSchema.parse({
          idea: String(input.idea ?? "").trim(),
          ...(input.context ? { context: String(input.context) } : {}),
          ...(Array.isArray(input.constraints) ? { constraints: input.constraints.map(String) } : {}),
        })
        const existing = await readPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the current plan: ${error.message}`)
        })
        const ideas = existing ? await readIdeas(root) : []
        if (existing && ideas.length && input.force !== true)
          throw new ToolRefusal(
            `A brainstorm is already in progress (${ideas.length} idea(s) recorded). Pass force:true to replace it, or finish it with es_brainstorm_complete.`,
          )
        let built: ReturnType<typeof buildPlan>
        try {
          built = buildPlan(brief, {
            ...(Array.isArray(input.lenses) ? { lenses: input.lenses.map(String) } : {}),
            ...(input.ideasPerLens !== undefined ? { ideasPerLens: Number(input.ideasPerLens) } : {}),
            ...(input.shortlistSize !== undefined ? { shortlistSize: Number(input.shortlistSize) } : {}),
          } satisfies PlanOptions)
        } catch (error) {
          throw new ToolRefusal(error instanceof Error ? error.message : String(error))
        }
        await startRun(root, built.plan)
        const ids = built.lenses.map((lens) => `es-lens-${lens.id}`)
        return [
          `Brainstorm planned: "${built.plan.brief.idea}"`,
          `Lenses (${built.lenses.length}): ${built.lenses.map((lens) => `${lens.id} (${lens.name})`).join(", ")}`,
          `Caps: ≤${built.plan.ideasPerLens} ideas per lens, ≤${built.plan.maxIdeaChars} characters each; shortlist ${built.plan.shortlistSize}.`,
          "",
          "Next steps:",
          `1. Launch every lens subagent in parallel by exact ID: ${ids.join(", ")}.`,
          "   Give each one the brief (and constraints) plus how many ideas you expect.",
          "2. Record each lens's ideas with es_brainstorm_record (one call per lens).",
          "3. Launch es-brainstorm-critic with the surviving idea ids and texts; it scores each with es_brainstorm_score.",
          `4. Call es_brainstorm_complete. Dedupe, ranking and the shortlist (with one forced outlier) are computed there.`,
          "",
          `Rubric (1-5 each): ${RUBRIC.map((item) => item.id).join(", ")}.`,
        ].join("\n")
      },
    },
    {
      name: "es_brainstorm_record",
      description:
        "Brainstormer only: record one lens's ideas. Rejects caps violations, near-duplicates are collapsed against earlier ideas.",
      input: object(
        {
          lens: { type: "string" },
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
        if (seatOf(toolContext.agent) !== "brainstormer")
          throw new ToolRefusal("Only the brainstormer seat may record ideas.")
        const plan = await readPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No brainstorm plan. Call es_brainstorm_plan first.")
        const lens = String(input.lens ?? "")
        if (!plan.lenses.includes(lens))
          throw new ToolRefusal(`"${lens}" is not in this plan. Planned lenses: ${plan.lenses.join(", ")}.`)
        const batch = Array.isArray(input.ideas) ? input.ideas : []
        if (!batch.length) throw new ToolRefusal("Give at least one idea.")
        const existing = await readIdeas(root)
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
        const hits = collapseDuplicates(all, plan.dedupeThreshold)
        const byId = new Map(hits.map((hit) => [hit.id, hit]))
        const stored = all.map((idea) => {
          const hit = byId.get(idea.id)
          return hit ? { ...idea, duplicateOf: hit.duplicateOf, similarity: hit.similarity } : idea
        })
        await writeIdeas(root, stored)
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
        const plan = await readPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No brainstorm plan to score against.")
        const ideas = await readIdeas(root)
        const scores = await readScores(root)
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
        await writeScores(root, [...merged.values()])
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
        "Brainstormer only: collapse duplicates, rank the scored ideas and write the diversified shortlist with a forced outlier slot.",
      input: object({
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
        if (seatOf(toolContext.agent) !== "brainstormer")
          throw new ToolRefusal("Only the brainstormer seat may complete a brainstorm.")
        const plan = await readPlan(root).catch((error: Error) => {
          throw new ToolRefusal(`Cannot read the plan: ${error.message}`)
        })
        if (!plan) throw new ToolRefusal("No brainstorm plan. Call es_brainstorm_plan first.")
        const ideas = await readIdeas(root)
        if (!ideas.length) throw new ToolRefusal("No ideas recorded yet.")
        const hits = collapseDuplicates(ideas, plan.dedupeThreshold)
        const hitById = new Map(hits.map((hit) => [hit.id, hit]))
        const survivors = ideas.filter((idea) => !hitById.has(idea.id))
        const coverage: Record<string, number> = {}
        for (const lens of plan.lenses) coverage[lens] = survivors.filter((idea) => idea.lens === lens).length
        const gaps = plan.lenses.filter((lens) => coverage[lens] === 0)
        if (gaps.length && input.allowPartial !== true)
          throw new ToolRefusal(
            `These planned lenses produced no surviving idea: ${gaps.join(", ")}. Record ideas for them, or pass allowPartial:true to finish with gaps.`,
          )
        const scores = new Map((await readScores(root)).map((score) => [score.id, score]))
        const unscored = survivors.filter((idea) => !scores.has(idea.id))
        if (unscored.length)
          throw new ToolRefusal(
            `Still unscored: ${list(unscored.map((idea) => idea.id))}. Have es-brainstorm-critic score them (es_brainstorm_score) first.`,
          )
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
          ...(Array.isArray(input.priorArt) && input.priorArt.length ? { priorArt: input.priorArt } : {}),
          stats: {
            lenses: plan.lenses.length,
            ideas: survivors.length,
            duplicates: hits.length,
            scored: survivors.length,
          },
          completedAt: now(),
        })
        await writeResult(root, result, renderBrainstorm(result))
        const short = shortlist
          .map((entry, index) => {
            const idea = survivors.find((item) => item.id === entry.id)!
            return `${index + 1}. ${entry.id} (${entry.total}/20)${entry.outlier ? " · outlier" : ""} — ${idea.title}`
          })
          .join("\n")
        return [
          `Brainstorm complete: ${survivors.length} ideas, ${hits.length} duplicate(s) collapsed, ${plan.lenses.length} lenses.`,
          `Shortlist (${shortlist.length}):`,
          short,
          `Written: ${factoryLayout(root).dir}/brainstorm/brainstorm.json and BRAINSTORM.md`,
        ].join("\n")
      },
    },
  ]
}
