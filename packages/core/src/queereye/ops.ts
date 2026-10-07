// Harness-neutral queereye tools. The interview is schema-typed: each answer
// is validated inline by its repair hook, vague or smuggled answers come back
// as counter-questions (never agreement), and completion refuses until the
// token tree validates with zero one-off mints and every contrast pair passes.
// Phase 02 (component specs + webref + csf + tui notes) and phase 03 (the
// skill-harvest ledger bundle + cite-gate receipt) extend the same surface.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { seatOf } from "../agents/registry.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { ToolRefusal } from "../ops/tools.ts"
import type { ProbeRow } from "../schema/queereye.ts"
import {
  bundleFiles,
  bundlePath,
  canonicalIndentedJson,
  harvestManifest,
  renderReceipt,
  verifyCiteGate,
} from "./bundle.ts"
import { gatePairs, probeReport } from "./contrast.ts"
import { allExemplarStories, runPlaySuite, specVsRenderCheck, validateAllStories } from "./csf.ts"
import {
  disclosureBudgetCheck,
  HARVEST_ROWS,
  renderOverlaySkillMd,
  renderSkillMd,
  TRANSITIVE_DEPS,
  validateLedger,
  validateSkillFrontmatter,
  validateTransitiveClosure,
} from "./ledger.ts"
import { compileToCssVars, renderGuide } from "./render.ts"
import { AXES, type Axis, ContradictionError, FORMS, SlotLoop, SmuggledValueError, VagueAnswerError } from "./slots.ts"
import { EXEMPLARS, renderSpecMd, specFilename, validateAll } from "./specs.ts"
import {
  checkDrift,
  designPaths,
  loadInterview,
  readProbes,
  readTokens,
  saveInterview,
  writeArtifacts,
  writeIfChanged,
} from "./store.ts"
import { aliasReuseRatio, findOneOffs, validateTokens } from "./tokens.ts"
import { renderTuiNotes, validateTuiCoverage } from "./tui.ts"
import { isWebrefFresh, licenseGate, verifySnapshot, WEBREF_PINNED_ON, webrefManifest } from "./webref.ts"

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
  const done = AXES.reduce((sum, axis) => sum + loop.values[axis].size + loop.skipped[axis].size, 0)
  return next
    ? `${done}/${total} slots settled. Next: ${next.axis}.${next.slot} — ${next.question}${next.recommendations.length ? ` (options: ${next.recommendations.join(", ")})` : ""}`
    : `${done}/${total} slots settled. The interview is complete; run es_design_complete.`
}

/** `.factory/design/csf.json`: story inventory + play pass-rate (d66328c:csf.py write_csf_manifest). */
function csfManifest(): Record<string, unknown> {
  const suite = runPlaySuite()
  return {
    stories: allExemplarStories(),
    play_pass_rate: Math.round(suite.passRate * 10000) / 10000,
    headless: true,
    evidence: { csf_standard: "60c8c31d" },
    specs: Object.keys(EXEMPLARS).sort(),
  }
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
    {
      name: "es_design_specs",
      description:
        "Designer only: phase 02 — validate and write the component specs, the pinned webref snapshot, the CSF play-harness manifest and the TUI lowering notes. check:true only re-checks drift and the gates.",
      input: object({ check: { type: "boolean" } }),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "designer")
          throw new ToolRefusal("Only the designer seat may run the design interview.")
        const checkOnly = input.check === true
        const surfaceErrors = [
          ...Object.entries(validateAll()).flatMap(([name, errors]) => errors.map((error) => `${name}: ${error}`)),
          ...Object.values(validateAllStories()).flatMap((errors) => errors.map((error) => `csf: ${error}`)),
          ...verifySnapshot(webrefManifest()).map((error) => `webref: ${error}`),
          ...licenseGate("MIT", "vendor").map((error) => `webref: ${error}`),
        ]
        if (surfaceErrors.length)
          throw new ToolRefusal(`The phase-02 surface does not validate:\n- ${surfaceErrors.join("\n- ")}`)
        const suite = runPlaySuite()
        if (suite.passRate < 1)
          throw new ToolRefusal(`The play suite pass rate is ${suite.passRate.toFixed(2)} (< 1.00).`)

        const files: Array<[string, string]> = [
          ...Object.entries(EXEMPLARS).map(
            ([name, spec]) => [bundlePath(root, specFilename(name)), renderSpecMd(spec)] as [string, string],
          ),
          [designPaths(root).webref, canonicalIndentedJson(webrefManifest())],
          [designPaths(root).tuiNotes, renderTuiNotes()],
          [designPaths(root).csf, canonicalIndentedJson(csfManifest())],
        ]

        if (checkOnly) {
          const drift: string[] = []
          for (const [file, content] of files) {
            const onDisk = await readFile(file, "utf8").catch(() => undefined)
            if (onDisk === undefined) drift.push(`${path.relative(root, file)} (missing)`)
            else if (onDisk !== content) drift.push(`${path.relative(root, file)} (differs from the renderer)`)
          }
          for (const [name, spec] of Object.entries(EXEMPLARS)) {
            for (const error of validateTuiCoverage(spec)) drift.push(`${name}: ${error}`)
            for (const error of specVsRenderCheck(spec, Object.keys(spec.slots ?? {}).sort(), isWebrefFresh()))
              drift.push(error)
          }
          if (drift.length) throw new ToolRefusal(`Phase-02 drift:\n- ${drift.join("\n- ")}`)
          return "Phase-02 check: specs, webref, csf and tui-notes byte-match the renderers; coverage, spec-vs-render, freshness and the play suite pass."
        }

        const written: string[] = []
        for (const [file, content] of files) {
          const outcome = await writeIfChanged(file, content)
          if (outcome.wrote) written.push(path.relative(root, file))
        }
        return [
          `Phase-02 written: ${Object.keys(EXEMPLARS).length} component spec(s), webref.json, csf.json, tui-notes.md${written.length ? ` (${written.length} file(s) changed)` : " (no drift)"}.`,
          `Play suite: ${Object.keys(suite.results).length} story/stories at pass rate ${suite.passRate.toFixed(2)}; webref pinned ${WEBREF_PINNED_ON} and fresh.`,
        ].join("\n")
      },
    },
    {
      name: "es_design_harvest",
      description:
        "Designer only: phase 03 — validate and write .factory/design/harvest.json (the skill-harvest ledger) and the skill bundle, then verify the cite-gate receipt. check:true only re-checks drift.",
      input: object({ check: { type: "boolean" } }),
      execute: async (input, toolContext) => {
        if (seatOf(toolContext.agent) !== "designer")
          throw new ToolRefusal("Only the designer seat may run the design interview.")
        const checkOnly = input.check === true
        const gateErrors = [
          ...validateLedger().map((error) => `ledger: ${error}`),
          ...validateTransitiveClosure().map((error) => `closure: ${error}`),
          ...validateSkillFrontmatter(renderSkillMd()).map((error) => `skill: ${error}`),
          ...disclosureBudgetCheck(renderSkillMd()).map((error) => `skill budget: ${error}`),
          ...validateSkillFrontmatter(renderOverlaySkillMd()).map((error) => `overlay: ${error}`),
          ...disclosureBudgetCheck(renderOverlaySkillMd()).map((error) => `overlay budget: ${error}`),
        ]
        if (gateErrors.length)
          throw new ToolRefusal(`The phase-03 surface does not validate:\n- ${gateErrors.join("\n- ")}`)

        const files: Array<[string, string]> = [
          [designPaths(root).harvest, canonicalIndentedJson(harvestManifest())],
          ...Object.entries(bundleFiles()).map(([rel, body]) => [bundlePath(root, rel), body] as [string, string]),
          [bundlePath(root, "skill-claude/SKILL.md"), renderOverlaySkillMd()],
        ]

        if (checkOnly) {
          const drift: string[] = []
          for (const [file, content] of files) {
            const onDisk = await readFile(file, "utf8").catch(() => undefined)
            if (onDisk === undefined) drift.push(`${path.relative(root, file)} (missing)`)
            else if (onDisk !== content) drift.push(`${path.relative(root, file)} (differs from the renderer)`)
          }
          const receipt = await readFile(bundlePath(root, "cite-gate-demo.md"), "utf8").catch(() => undefined)
          if (receipt === undefined) drift.push("cite-gate-demo.md (missing)")
          else drift.push(...(await verifyCiteGate(receipt, root)))
          if (drift.length) throw new ToolRefusal(`Phase-03 drift:\n- ${drift.join("\n- ")}`)
          return "Phase-03 check: harvest.json and the skill bundle byte-match the renderers; the cite-gate receipt verifies."
        }

        const written: string[] = []
        for (const [file, content] of files) {
          const outcome = await writeIfChanged(file, content)
          if (outcome.wrote) written.push(path.relative(root, file))
        }
        const rowCount = `${HARVEST_ROWS.length} ledger row(s), ${TRANSITIVE_DEPS.length} closure entry/entries`
        // The receipt binds the live tokens + ledger digests, so it needs the
        // phase-01 tokens; without them the ledger surface still lands.
        let receiptNote: string
        try {
          const receipt = await renderReceipt(root)
          await writeIfChanged(bundlePath(root, "cite-gate-demo.md"), receipt)
          const errors = await verifyCiteGate(receipt, root)
          if (errors.length) throw new ToolRefusal(`The cite-gate receipt does not verify:\n- ${errors.join("\n- ")}`)
          receiptNote = "cite-gate receipt verifies (tokens + ledger bound; contrast and render-match green)."
        } catch (error) {
          if (error instanceof ToolRefusal) throw error
          receiptNote = `cite-gate receipt deferred until the token tree exists: ${error instanceof Error ? error.message : String(error)}`
        }
        return [
          `Phase-03 written: harvest.json (${rowCount})${written.length ? ` and ${written.length} bundle file(s)` : " (no drift)"}.`,
          receiptNote,
        ].join("\n")
      },
    },
  ]
}
