// `es audit <target>` and `es scout <objective>`: open the job as the human at
// the terminal, then drive the seat headlessly until it settles. Both run on a
// factory run with a spend ceiling (decision 7): with none, `--max-usd N`
// starts a GRILL run with that provisional ceiling, confirmed with the passphrase.

import { mkdir, stat } from "node:fs/promises"
import { userInfo } from "node:os"
import path from "node:path"
import {
  type Args,
  allAudits,
  describeTarget,
  Factory,
  factoryLayout,
  flag,
  gateRunner,
  parseAuditTarget,
  parseModelRef,
  readAssessments,
  readScoutPlan,
  readScoutResult,
  scoutPaths,
} from "@heretek-ai/es-core"
import {
  DRIVERS,
  driveHeadless,
  type HeadlessEvent,
  LOG_LEVELS,
  type LogLevel,
  logLevel,
  presentEvent,
} from "./headless.ts"
import type { HumanContext } from "./human.ts"
import { confirmHuman } from "./tty.ts"

const user = () => userInfo().username

const factoryFor = (context: HumanContext) =>
  new Factory(context.root, {
    gates: gateRunner(context.stateDir ? { stateDir: context.stateDir } : {}),
    ...(context.stateDir ? { stateDir: context.stateDir } : {}),
  })

/** Make sure a run with a ceiling exists; returns false (after printing why) when it cannot. */
async function ensureCeiling(context: HumanContext, args: Args, purpose: string): Promise<boolean | number> {
  const factory = factoryFor(context)
  const state = await factory.read()
  if (state?.spendCeilingUSD !== undefined) return true
  const raw = flag(args, "max-usd")
  const ceiling = raw === undefined ? Number.NaN : Number(raw)
  if (!(ceiling > 0)) {
    context.print(
      `${purpose} needs a spend ceiling and ${state ? "this run has none yet" : "there is no factory run here"}. Give one: --max-usd <USD>.`,
    )
    return 2
  }
  const lines = [
    state
      ? `Run ${state.runId} (${state.stage}) gets a provisional spend ceiling of $${ceiling}.`
      : `A factory run starts in GRILL with a provisional spend ceiling of $${ceiling}.`,
    "Seats halt when the spend reaches it; a later frontier approval sets the real ceiling.",
  ]
  if (
    !(await confirmHuman(context.io, `${purpose}: set a $${ceiling} ceiling as ${user()}`, lines, context.stateDir))
  ) {
    context.print("Cancelled; nothing was started.")
    return 1
  }
  await factory.provisionRun(user(), ceiling)
  return true
}

/** A driver that can run now, checked before anything is opened or started. */
async function driverFor(context: HumanContext, args: Args) {
  const driver = DRIVERS[flag(args, "driver") ?? "opencode"]
  if (!driver) {
    context.print(`Unknown driver. Available: ${Object.keys(DRIVERS).join(", ")}`)
    return undefined
  }
  if (!(await driver.available())) {
    context.print(
      `The ${driver.id} CLI is not installed or not on PATH; nothing was started. Use the slash command in OpenCode instead.`,
    )
    return undefined
  }
  return driver
}

async function* drain(
  context: HumanContext,
  level: LogLevel,
  events: AsyncGenerator<HeadlessEvent>,
): AsyncGenerator<HeadlessEvent> {
  for await (const event of events) {
    const shown = presentEvent(event, level)
    if (shown !== undefined) context.print(JSON.stringify(shown))
    yield event
  }
}

/** The job's `--log-level`, or undefined after printing why it is invalid. */
function levelFor(context: HumanContext, args: Args): LogLevel | undefined {
  const level = logLevel(args)
  if (!level) context.print(`Unknown --log-level. Use one of: ${LOG_LEVELS.join(", ")} (default info).`)
  return level
}

const turns = (args: Args) => (flag(args, "max-turns") ? Number(flag(args, "max-turns")) : undefined)

export async function auditCommand(context: HumanContext, args: Args): Promise<number> {
  const raw = args.positionals[0]
  if (!raw) {
    context.print(
      "Usage: es audit <active phase id | path> [--max-usd N] [--open-only] [--max-turns N] | show [id] | dismiss <id> --reason … | verify",
    )
    return 2
  }
  const level = levelFor(context, args)
  if (!level) return 2
  const openOnly = args.flags["open-only"] === true
  const driver = openOnly ? undefined : await driverFor(context, args)
  if (!openOnly && !driver) return 2
  const ready = await ensureCeiling(context, args, "A code audit")
  if (ready !== true) return ready as number
  const factory = factoryFor(context)
  const state = (await factory.read())!
  const { audit } = await factory.openAudit(
    `human:${user()}`,
    parseAuditTarget(
      raw,
      state.phases.map((phase) => phase.id),
    ),
  )
  context.print(`Opened ${audit.id} (round ${audit.round}) on ${describeTarget(audit.target)}.`)
  if (openOnly || !driver) {
    context.print("Run /audit in OpenCode, or `es audit` again without --open-only, to have the auditor pair run it.")
    return 0
  }
  let outcome: HeadlessEvent | undefined
  for await (const event of drain(
    context,
    level,
    driveHeadless(
      {
        root: context.root,
        driver,
        ...(turns(args) ? { maxTurns: turns(args)! } : {}),
        ...(context.stateDir ? { stateDir: context.stateDir } : {}),
      },
      {
        agent: "factory",
        prompt: async (current, f) =>
          `${await f.summary(current)}\nHeadless code audit ${audit.id} on ${describeTarget(audit.target)}: launch es-auditor-thesis and es-auditor-antithesis in parallel (both subagent calls in one message, in the foreground) with the audit id and target. If they disagree, launch es-manager to break the tie (es_tiebreak with audit). No human will answer questions.`,
        finished: async (current) => {
          const now = allAudits(current).find((item) => item.id === audit.id)
          if (!now || now.status === "open") return undefined
          return {
            type: "done",
            audit: audit.id,
            status: now.status,
            report: path.relative(context.root, factoryLayout(context.root).auditReport(audit.id)),
          }
        },
        progress: async (current) => {
          const now = allAudits(current).find((item) => item.id === audit.id)
          return JSON.stringify([
            now?.status,
            now?.round,
            now?.thesis?.verdict,
            now?.antithesis?.verdict,
            now?.tiebreak?.verdict,
          ])
        },
      },
    ),
  ))
    outcome = event
  if (outcome?.type === "done") {
    context.print(`Audit ${audit.id} ${outcome.status}. Report: ${outcome.report}`)
    return outcome.status === "passed" || outcome.status === "dismissed" ? 0 : 1
  }
  return 1
}

export async function auditShow(context: HumanContext, args: Args): Promise<number> {
  const state = await factoryFor(context).read()
  const audits = state ? allAudits(state) : []
  const id = args.positionals[0]
  const shown = id ? audits.filter((audit) => audit.id === id) : audits
  if (!shown.length) {
    context.print(id ? `No audit "${id}" in this run.` : "No code audits in this run.")
    return id ? 1 : 0
  }
  for (const audit of shown)
    context.print(
      `${audit.id} · ${describeTarget(audit.target)} · ${audit.status} (round ${audit.round}) · thesis ${audit.thesis?.verdict ?? "-"} · antithesis ${audit.antithesis?.verdict ?? "-"}${audit.tiebreak ? ` · tiebreak ${audit.tiebreak.verdict}` : ""}${audit.dismissed ? ` · dismissed by ${audit.dismissed.by}: ${audit.dismissed.reason}` : ""}\n  report: ${path.relative(context.root, factoryLayout(context.root).auditReport(audit.id))}`,
    )
  return 0
}

/** Human-only: stop an audit from blocking, with the reason on record. */
export async function auditDismiss(context: HumanContext, args: Args): Promise<number> {
  const id = args.positionals[0]
  const reason = flag(args, "reason")
  if (!id || !reason?.trim()) {
    context.print('Usage: es audit dismiss <id> --reason "why it may stop blocking"')
    return 2
  }
  const factory = factoryFor(context)
  const audit = (await factory.read().then((state) => (state ? allAudits(state) : []))).find((item) => item.id === id)
  if (!audit) {
    context.print(`No audit "${id}" in this run.`)
    return 1
  }
  const lines = [
    `${audit.id} on ${describeTarget(audit.target)} is ${audit.status} (round ${audit.round}).`,
    `Reason: ${reason}`,
    "It stops blocking the factory; the dismissal is signed into the audit log.",
  ]
  if (!(await confirmHuman(context.io, `Dismiss ${audit.id} as ${user()}`, lines, context.stateDir))) {
    context.print("Cancelled; the audit still blocks.")
    return 1
  }
  await factory.dismissAudit(user(), id, reason)
  context.print(`Dismissed ${id}.`)
  return 0
}

export async function scoutCommand(context: HumanContext, args: Args): Promise<number> {
  const objective = args.positionals.join(" ").trim()
  if (!objective) {
    context.print('Usage: es scout "<feature to adopt or rebuild>" [--max-usd N] [--max-turns N] | show [--json]')
    return 2
  }
  const level = levelFor(context, args)
  if (!level) return 2
  const driver = await driverFor(context, args)
  if (!driver) return 2
  const ready = await ensureCeiling(context, args, "A scout")
  if (ready !== true) return ready as number
  const started = new Date().toISOString()
  const done = async () => {
    const result = await readScoutResult(context.root).catch(() => undefined)
    return result && result.completedAt >= started ? result : undefined
  }
  let outcome: HeadlessEvent | undefined
  for await (const event of drain(
    context,
    level,
    driveHeadless(
      {
        root: context.root,
        driver,
        ...(turns(args) ? { maxTurns: turns(args)! } : {}),
        ...(context.stateDir ? { stateDir: context.stateDir } : {}),
      },
      {
        agent: "scout",
        prompt: async () =>
          (await readScoutPlan(context.root).catch(() => undefined))?.objective === objective
            ? `Continue the scout of "${objective}" until es_scout_complete succeeds. This is a headless run: no human will answer questions.`
            : `Scout: ${objective}. This is a headless run: no human will answer questions, so find candidates with es_scout_discover, plan them, scan, gather cited evidence, check advisories, record each, then es_scout_complete.`,
        finished: async () =>
          (await done())
            ? { type: "done", report: path.relative(context.root, scoutPaths(context.root).report) }
            : undefined,
        progress: async () => {
          const plan = await readScoutPlan(context.root).catch(() => undefined)
          const assessments = await readAssessments(context.root).catch(() => [])
          return JSON.stringify([plan?.createdAt, plan?.candidates.length, assessments.map((item) => item.recordedAt)])
        },
      },
    ),
  ))
    outcome = event
  const result = await done()
  if (outcome?.type === "done" && result) {
    for (const verdict of result.verdicts)
      context.print(
        `${verdict.rank}. ${verdict.name}: ${verdict.verdict}${verdict.downgraded ? ` (${verdict.downgraded})` : ""}`,
      )
    context.print(`Report: ${outcome.report}. Adoption is your decision.`)
    return 0
  }
  return 1
}

export async function scoutShow(context: HumanContext, args: Args): Promise<number> {
  const result = await readScoutResult(context.root).catch(() => undefined)
  if (result) {
    if (args.flags.json === true) context.print(JSON.stringify(result, null, 2))
    else
      context.print(
        [
          `Scout: ${result.objective}`,
          ...result.verdicts.map(
            (verdict) =>
              `${verdict.rank}. ${verdict.name} — ${verdict.license.spdx}${verdict.license.verified ? "" : " (unverified)"} — ${verdict.verdict}`,
          ),
        ].join("\n"),
      )
    return 0
  }
  const plan = await readScoutPlan(context.root).catch(() => undefined)
  if (plan) {
    const recorded = new Set((await readAssessments(context.root).catch(() => [])).map((item) => item.candidate))
    context.print(
      `Scout in progress: ${plan.objective}\nCandidates: ${plan.candidates.map((item) => `${item.id}${recorded.has(item.id) ? " ✓" : ""}`).join(", ")}`,
    )
    return 0
  }
  context.print('No scout in .factory/scout. Start one with /scout in OpenCode or `es scout "<feature>" --max-usd N`.')
  return 1
}

/**
 * Human-only `es research deep <query> --output <dir> --max-usd N`: start a
 * research-only run in the output directory (created; no git repo needed)
 * and drive the deep-researcher headlessly until REPORT.md completes at DONE.
 */
export async function researchDeepCommand(context: HumanContext, args: Args): Promise<number> {
  const query = args.positionals.join(" ").trim()
  if (!query) {
    context.print(
      'Usage: es research deep "<question>" --output <dir> --max-usd N [--driver <id>] [--model provider/model] [--max-turns N]',
    )
    return 2
  }
  const level = levelFor(context, args)
  if (!level) return 2
  // Validate inputs before touching the environment, so usage errors read
  // the same with or without a driver installed.
  const model = flag(args, "model")
  if (model !== undefined && !parseModelRef(model)) {
    context.print(`Bad --model "${model}": expected "provider/model" (both parts non-empty, no spaces).`)
    return 2
  }
  const rawCeiling = flag(args, "max-usd")
  const ceiling = rawCeiling === undefined ? Number.NaN : Number(rawCeiling)
  if (!(ceiling > 0)) {
    context.print("Deep research needs a spend ceiling. Give one: --max-usd <USD>.")
    return 2
  }
  const driver = await driverFor(context, args)
  if (!driver) return 2
  const outDir = path.resolve(context.root, flag(args, "output") ?? ".")
  await mkdir(outDir, { recursive: true })
  const factory = new Factory(outDir, {
    gates: gateRunner(context.stateDir ? { stateDir: context.stateDir } : {}),
    ...(context.stateDir ? { stateDir: context.stateDir } : {}),
  })
  const lines = [
    `A research-only run starts in ${path.relative(context.root, outDir) || outDir} with a $${ceiling} ceiling.`,
    "The deep-researcher runs thesis, antithesis and synthesis headlessly; seats halt when the spend reaches the ceiling.",
  ]
  if (!(await confirmHuman(context.io, `Deep research: ${query}`, lines, context.stateDir))) {
    context.print("Cancelled; nothing was started.")
    return 1
  }
  const begun = await factory.beginResearchRun({ objective: query, ceilingUSD: ceiling }, `human:${user()}`)
  context.print(`Research run ${begun.runId} started: "${query}".`)
  const report = path.join(factoryLayout(outDir).research, "REPORT.md")
  let outcome: HeadlessEvent | undefined
  for await (const event of drain(
    context,
    level,
    driveHeadless(
      {
        root: outDir,
        driver,
        ...(turns(args) ? { maxTurns: turns(args)! } : {}),
        ...(context.stateDir ? { stateDir: context.stateDir } : {}),
        ...(model ? { model } : {}),
      },
      {
        agent: "deep-researcher",
        prompt: async () =>
          `${await factory.summary()}\nDeep research: ${query}. This is a headless run: no human will answer questions, so write the plan note, launch es-research-alpha and es-research-beta in parallel (both subagent calls in one message, in the foreground), then es-research-synthesizer with the disputes, then es_research_audit and es_research_complete.`,
        finished: async (current) =>
          current.stage === "DONE" ? { type: "done", report: path.relative(context.root, report) } : undefined,
        progress: async (current) => {
          const stamp = async (file: string) =>
            stat(file)
              .then((info) => `${info.size}@${info.mtimeMs}`)
              .catch(() => "-")
          const research = factoryLayout(outDir).research
          return JSON.stringify([
            current.stage,
            await stamp(path.join(research, "alpha.md")),
            await stamp(path.join(research, "beta.md")),
            await stamp(path.join(research, "REPORT.md")),
          ])
        },
      },
    ),
  ))
    outcome = event
  if (outcome?.type === "done") {
    context.print(`Research complete: ${outcome.report}`)
    return 0
  }
  return 1
}
