// Harness-neutral Epistemic Swarm tool operations. Each adapter (OpenCode
// tools, the MCP server, Claude/Pi/Antigravity) wraps these: the logic, seat
// checks (by agent ID, in the factory) and model-facing text live here once.

import { seatOf } from "../agents/registry.ts"
import { approvalSubject } from "../approval/record.ts"
import { appendAuditEntry } from "../audit/chain.ts"
import type { Factory } from "../factory/machine.ts"
import { factorySummary } from "../factory/summary.ts"
import { computeFrontier, treeCounts } from "../factory/tree.ts"
import { validateArtifacts } from "../gates/artifacts.ts"
import { formatReport, runGates } from "../gates/engine.ts"
import { factoryLayout } from "../layout.ts"
import type { ApprovalStage } from "../schema/approval.ts"
import type { GateFinding } from "../schema/gates.ts"
import { relativeTo } from "../trust/paths.ts"
import { readJson, writeJson } from "../util/fs.ts"

export type EsToolContext = { readonly agent: string; readonly sessionID?: string; readonly signal?: AbortSignal }
export interface EsToolDef {
  readonly name: string
  readonly description: string
  /** JSON Schema of the input object. */
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context: EsToolContext) => Promise<string>
}

/** The tool refused (wrong seat, stage or input); the message is model-facing. */
export class ToolRefusal extends Error {}

export interface OpsContext {
  readonly root: string
  readonly factory: Factory
  readonly stateDir: string
  /** Language-server diagnostics for the touched-scope "lsp" gate. */
  readonly lsp?: { diagnostics(file: string, options?: { maxWaitMs?: number }): Promise<unknown> }
}

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

function findingsText(findings: readonly GateFinding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.severity === "error" ? "✗" : "!"} ${finding.file}${finding.line ? `:${finding.line}` : ""} ${finding.rule}: ${finding.message}${finding.fixHint ? `\n    ↳ ${finding.fixHint.split("\n")[0]}` : ""}`,
    )
    .join("\n")
}

export interface PendingApproval {
  readonly stage: ApprovalStage
  readonly requestedBy: string
  readonly at: string
  readonly note?: string
}

export async function pendingApprovals(root: string): Promise<PendingApproval[]> {
  return (await readJson<PendingApproval[]>(factoryLayout(root).pending).catch(() => undefined)) ?? []
}

export function esTools(ops: OpsContext): EsToolDef[] {
  const { factory, root } = ops
  const status = async () => {
    const state = await factory.read()
    const lines = [await factory.summary(state)]
    const pending = await pendingApprovals(root)
    if (pending.length)
      lines.push(
        `Waiting for a human to approve: ${pending.map((item) => item.stage).join(", ")} (/es-approve in the TUI, or \`es approve <stage>\`).`,
      )
    const phase = state?.phases.find((item) => item.id === state.activePhase)
    if (phase) {
      const recent = phase.history
        .slice(-6)
        .map((entry) => `  ${entry.at.slice(11, 19)} ${entry.event}${entry.notes ? `: ${entry.notes}` : ""}`)
      if (recent.length) lines.push(`Recent ${phase.id} events:\n${recent.join("\n")}`)
      for (const [seat, verdict] of Object.entries(phase.qa))
        if (verdict) lines.push(`QA ${seat}: ${verdict.verdict} — ${verdict.notes}`)
    }
    return lines.join("\n")
  }

  return [
    {
      name: "es_status",
      description:
        "Show the factory state: stage, phases, worktree paths, QA verdicts, spend and pending human approvals.",
      input: object(),
      execute: status,
    },
    {
      name: "es_frontier_write",
      description:
        "Grill only: save the full design tree (validated against the previous save: nodes are never deleted; reopen a settled node with status open before changing it). Returns the next round's questions. Set settled:true only when no node is open and the human agrees.",
      input: object({ frontier: { type: "object", description: "The complete frontier.json object." } }, ["frontier"]),
      execute: async ({ frontier }, context) => {
        const saved = await factory.writeFrontier(context.agent, frontier)
        const counts = treeCounts(saved)
        const next = computeFrontier(saved)
        return [
          `Saved frontier (round ${counts.round}): ${counts.total} nodes — ${counts.settled} settled, ${counts.open} open, ${counts.deferred} deferred${counts.facts ? ` (${counts.facts} fact(s) for research)` : ""}; ceiling $${saved.spendCeiling.maxAmount}; settled=${saved.settled}.`,
          next.length
            ? `Next round (${next.length}): ${next.map((node) => node.id).join(", ")}. Ask them all in one message, numbered, each with your recommendation.`
            : counts.open
              ? "Open nodes remain, but each waits on an unsettled parent: settle or defer the parents."
              : saved.settled
                ? "The tree is frozen. Request the human's approval with es_request_approval (stage frontier)."
                : "No open questions left: summarise the settled constraints, confirm with the human, then save settled:true.",
        ].join("\n")
      },
    },
    {
      name: "es_request_approval",
      description:
        "Ask the human to approve a checkpoint (frontier or spec). You cannot approve; this only validates the artifacts and records the request.",
      input: object({ stage: { type: "string", enum: ["frontier", "spec"] }, note: { type: "string" } }, ["stage"]),
      execute: async ({ stage, note }, context) => {
        const seat = seatOf(context.agent)
        if (!seat || !["factory", "grill", "manager"].includes(seat))
          throw new ToolRefusal("Only the factory, grill or manager seat may request approvals.")
        const subject = await approvalSubject(root, stage).catch((error: Error) => {
          const missing =
            /missing artifact.*frontier|not settled yet|frontier/i.test(error.message) && stage === "frontier"
          throw new ToolRefusal(
            `Not ready for approval: ${error.message}${missing ? " Run /grill (or `es factory begin` + grill flow) to record the frontier, then request approval again." : ""}`,
          )
        })
        const pending = (await pendingApprovals(root)).filter((item) => item.stage !== stage)
        pending.push({ stage, requestedBy: context.agent, at: new Date().toISOString(), ...(note ? { note } : {}) })
        await writeJson(factoryLayout(root).pending, pending)
        await appendAuditEntry(root, {
          actor: `agent:${context.agent}`,
          action: "approval.request",
          payload: { stage },
        })
        return [
          `Requested human approval for "${stage}". A human must run /es-approve in the TUI (or \`es approve ${stage}\` in a terminal). Wait for it; do not proceed.`,
          ...subject.summary,
        ].join("\n")
      },
    },
    {
      name: "es_research_complete",
      description: "Factory only: finish RESEARCH once .factory/research/REPORT.md is written; moves to SPEC.",
      input: object(),
      execute: async (_input, context) => factorySummary(await factory.completeResearch(context.agent)),
    },
    {
      name: "es_spec_validate",
      description:
        "Validate .factory/roadmap.json and every phase GOAL.md against their schemas. Run until it reports no errors.",
      input: object(),
      execute: async () => {
        const problems = await validateArtifacts(root)
        const subject = await approvalSubject(root, "spec").then(
          (result) => result,
          (error: Error) => error,
        )
        if (subject instanceof Error)
          return `Spec is not valid yet:\n- ${subject.message}${problems.length ? `\n${findingsText(problems)}` : ""}`
        if (problems.length) return `Spec has artifact problems:\n${findingsText(problems)}`
        return `Spec is valid:\n${subject.summary.join("\n")}\nRequest the human's approval with es_request_approval (stage "spec").`
      },
    },
    {
      name: "es_build_start",
      description:
        "Factory only: after the human approved the spec, start the autonomous build (creates the run branch and the first phase worktree).",
      input: object(),
      execute: async (_input, context) => factorySummary(await factory.startBuild(context.agent)),
    },
    {
      name: "es_gates_run",
      description:
        "Run the mechanical gates. With files: touched scope (format, lint, typecheck findings in those files, related tests, budgets, secrets). Without files: full scope. Runs in your phase worktree when you are a factory seat during a build.",
      input: object({
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths or paths relative to the run directory.",
        },
        scope: { type: "string", enum: ["touched", "full"] },
      }),
      execute: async ({ files, scope }, context) => {
        const seat = seatOf(context.agent)
        const state = await factory.read()
        const worktree = seat && seat !== "factory" && seat !== "grill" ? await factory.activeWorktree() : undefined
        const dir = worktree ?? root
        const phase = state?.phases.find((item) => item.id === state.activePhase)
        const touched = ((files as string[] | undefined) ?? [])
          .map((file) => (file.startsWith("/") ? relativeTo(dir, file) : file))
          .filter((file): file is string => Boolean(file))
        const effectiveScope = scope ?? (touched.length ? "touched" : "full")
        const report = await runGates({
          root,
          dir,
          scope: effectiveScope,
          touched,
          ...(worktree && phase?.baseCommit ? { base: phase.baseCommit, phaseId: phase.id } : {}),
          ...(state ? { runId: state.runId } : {}),
          stateDir: ops.stateDir,
          ...(ops.lsp ? { lsp: ops.lsp } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        })
        if (seat === "programmer") await factory.recordGateRun(context.agent, report)
        return formatReport(report)
      },
    },
    {
      name: "es_complete",
      description:
        "Programmer only: finish the phase. Checks acceptance criteria, red-first evidence and full gates in the worktree, then commits and hands the phase to QA.",
      input: object(),
      execute: async (_input, context) => {
        const result = await factory.complete(context.agent)
        const criteria = result.criteria.map((item) => `${item.ok ? "✓" : "✗"} ${item.id}: ${item.detail}`).join("\n")
        return [result.summary, criteria, result.ok ? "" : findingsText(result.findings)].filter(Boolean).join("\n")
      },
    },
    {
      name: "es_qa_verdict",
      description:
        "QA seats only: record your verdict on the phase in QA. Fail with concrete, numbered notes (file:line, what, fix).",
      input: object({ verdict: { type: "string", enum: ["pass", "fail"] }, notes: { type: "string" } }, [
        "verdict",
        "notes",
      ]),
      execute: async ({ verdict, notes }, context) =>
        factorySummary(await factory.qaVerdict(context.agent, verdict, notes)),
    },
    {
      name: "es_tiebreak",
      description: "Manager only: decide a phase when the two QA seats disagree.",
      input: object({ verdict: { type: "string", enum: ["pass", "fail"] }, notes: { type: "string" } }, [
        "verdict",
        "notes",
      ]),
      execute: async ({ verdict, notes }, context) =>
        factorySummary(await factory.tiebreak(context.agent, verdict, notes)),
    },
    {
      name: "es_replan",
      description: "Manager only: after a phase's third failure, accept your revised GOAL.md for it (once per phase).",
      input: object({ notes: { type: "string", description: "What changed in the spec and why." } }, ["notes"]),
      execute: async ({ notes }, context) => factorySummary(await factory.replan(context.agent, notes)),
    },
    {
      name: "es_release",
      description:
        "Factory only: when every phase passed, run release gates on the integration branch and open a draft PR for a human to merge.",
      input: object(),
      execute: async (_input, context) => {
        const state = await factory.release(context.agent)
        return `${factorySummary(state)}\nPR opened: ${state.release?.prUrl}. A human reviews and merges it.`
      },
    },
  ]
}
