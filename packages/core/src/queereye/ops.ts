// Harness-neutral queereye tools. The interview is schema-typed: each answer
// is validated inline by its repair hook, vague or smuggled answers come back
// as counter-questions (never agreement), and completion refuses until the
// token tree validates with zero one-off mints and every contrast pair passes.
import { seatOf } from "../agents/registry.ts"
import { factoryLayout } from "../layout.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { ToolRefusal } from "../ops/tools.ts"
import type { ProbeRow } from "../schema/queereye.ts"
import { gatePairs, probeReport } from "./contrast.ts"
import { compileToCssVars, renderGuide } from "./render.ts"
import { AXES, type Axis, ContradictionError, FORMS, SlotLoop, SmuggledValueError, VagueAnswerError } from "./slots.ts"
import {
  checkDrift,
  designPaths,
  loadInterview,
  readProbes,
  readTokens,
  saveInterview,
  writeArtifacts,
} from "./store.ts"
import { aliasReuseRatio, findOneOffs, validateTokens } from "./tokens.ts"

export interface DesignOpsContext {
  readonly root: string
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const progressText = (loop: SlotLoop): string => {
  const next = loop.nextRequiredSlot()
  const total = AXES.reduce((sum, axis) => sum + FORMS[axis].requiredSlots.length, 0)
  const done = AXES.reduce((sum, axis) => sum + Object.keys(loop.values[axis]).length + loop.skipped[axis].size, 0)
  return next
    ? `${done}/${total} slots settled. Next: ${next.axis}.${next.slot} — ${next.question}${next.recommendations.length ? ` (options: ${next.recommendations.join(", ")})` : ""}`
    : `${done}/${total} slots settled. The interview is complete; run es_design_complete.`
}

export function designTools(context: DesignOpsContext): EsToolDef[] {
  const { root } = context
  const loopFor = async (): Promise<SlotLoop> => {
    const loop = new SlotLoop()
    await loadInterview(root, loop)
    return loop
  }

  return [
    {
      name: "es_design_status",
      description: "Designer only: show the interview progress and the next question (resumes from disk).",
      input: object({}),
      execute: async (_input, toolContext) => {
        if (seatOf(toolContext.agent) !== "designer")
          throw new ToolRefusal("Only the designer seat may run the design interview.")
        const loop = await loopFor()
        const lines = [progressText(loop)]
        const errors = loop.tokenErrors()
        if (errors.length) lines.push(`Incremental token errors (expected mid-interview): ${errors.length}`)
        return lines.join("\n")
      },
    },
    {
      name: "es_design_answer",
      description:
        "Designer only: submit one interview answer (axis.slot). Vague, smuggled or contradictory answers return a repair, never agreement.",
      input: object(
        {
          axis: { type: "string", enum: [...AXES] },
          slot: { type: "string" },
          value: { type: "string" },
        },
        ["axis", "slot", "value"],
      ),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "designer")
          throw new ToolRefusal("Only the designer seat may run the design interview.")
        const loop = await loopFor()
        try {
          const settled = loop.submit(input.axis as Axis, String(input.slot ?? ""), input.value)
          const outcomes = await saveInterview(root, loop)
          const conflict = outcomes.find((outcome) => outcome.note)
          return [
            `Accepted ${input.axis}.${input.slot} = "${settled}".`,
            progressText(loop),
            ...(conflict?.note ? [`⚠ ${conflict.note}`] : []),
          ].join("\n")
        } catch (error) {
          if (error instanceof VagueAnswerError) return `Not accepted (vague): ${error.counterQuestion}`
          if (error instanceof SmuggledValueError) return `Not accepted (smuggled): ${error.repair}`
          if (error instanceof ContradictionError) return `Not accepted (contradiction): ${error.repair}`
          throw new ToolRefusal(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: "es_design_skip",
      description: "Designer only: explicitly default one slot (skip words also do this through es_design_answer).",
      input: object({ axis: { type: "string", enum: [...AXES] }, slot: { type: "string" } }, ["axis", "slot"]),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "designer")
          throw new ToolRefusal("Only the designer seat may run the design interview.")
        const loop = await loopFor()
        try {
          loop.skip(input.axis as Axis, String(input.slot ?? ""))
        } catch (error) {
          throw new ToolRefusal(error instanceof Error ? error.message : String(error))
        }
        await saveInterview(root, loop)
        return [
          `Skipped ${input.axis}.${input.slot} (default: "${loop.effective(input.axis as Axis, String(input.slot))}").`,
          progressText(loop),
        ].join("\n")
      },
    },
    {
      name: "es_design_complete",
      description:
        "Designer only: finish the interview and write tokens.json, tokens.css, probes.json and STYLE_GUIDE.md. Refuses invalid trees, one-off mints or failing contrast pairs.",
      input: object({}),
      execute: async (_input, toolContext) => {
        if (seatOf(toolContext.agent) !== "designer")
          throw new ToolRefusal("Only the designer seat may run the design interview.")
        const loop = await loopFor()
        const next = loop.nextRequiredSlot()
        if (next)
          throw new ToolRefusal(
            `The interview is incomplete: ${next.axis}.${next.slot} is still open (${next.question}).`,
          )
        const tokens = loop.toTokens()
        const errors = validateTokens(tokens)
        if (errors.length) throw new ToolRefusal(`The token tree does not validate:\n- ${errors.join("\n- ")}`)
        const oneOffs = findOneOffs(tokens)
        if (oneOffs.length)
          throw new ToolRefusal(
            `One-off mints are compile errors:\n- ${oneOffs.map((item) => `${item.path}: ${item.reason}`).join("\n- ")}`,
          )
        const failing = gatePairs(loop.probePairs())
        if (failing.length)
          throw new ToolRefusal(`Contrast gate failed:\n- ${failing.map((row) => row.errors.join("; ")).join("\n- ")}`)
        const probes = probeReport(loop.probePairs())
        const outcomes = await writeArtifacts(root, {
          tokens,
          probes,
          guide: renderGuide(tokens, probes),
          css: compileToCssVars(tokens),
        })
        const reuse = aliasReuseRatio(tokens)
        const paths = designPaths(root)
        return [
          `Design complete: ${reuse.total} tokens (${reuse.aliased} aliased, reuse ratio ${reuse.ratio.toFixed(2)}), ${probes.length} contrast pair(s) pass, 0 one-offs.`,
          `Written: ${paths.tokens}, ${paths.css}, ${paths.probes}, ${paths.guide} (${outcomes.filter((outcome) => outcome.wrote).length} file(s) changed).`,
          ...outcomes.filter((outcome) => outcome.note).map((outcome) => `⚠ ${outcome.note}`),
        ].join("\n")
      },
    },
    {
      name: "es_design_check",
      description:
        "Designer only: re-render from tokens.json + probes.json and report drift, validation errors and one-off mints.",
      input: object({}),
      execute: async (_input, toolContext) => {
        if (seatOf(toolContext.agent) !== "designer")
          throw new ToolRefusal("Only the designer seat may run the design interview.")
        const report = await checkDrift(root)
        if (report.missing.length && !report.drifted.length)
          return `No committed design artifacts yet (missing: ${report.missing.join(", ")}).`
        const lines = [
          report.drifted.length || report.missing.length
            ? `Drift: ${[...report.drifted, ...report.missing.map((file) => `${file} (missing)`)].join(", ")}. Re-run es_design_complete.`
            : "STYLE_GUIDE.md and tokens.css byte-match the renderer output.",
          report.tokenErrors.length ? `Token errors: ${report.tokenErrors.length}` : "Token tree validates.",
        ]
        const tokens = await readTokens(root)
        if (tokens) lines.push(`One-off mints: ${findOneOffs(tokens).length}`)
        const probes: ProbeRow[] = (await readProbes(root)) ?? []
        lines.push(`Contrast pairs: ${probes.filter((row) => row.pass).length}/${probes.length} pass`)
        return lines.join("\n")
      },
    },
  ]
}
