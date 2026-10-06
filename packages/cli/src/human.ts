// Human-only commands: approve, trust, waive, resume. Each previews exactly
// what will be signed, then requires the typed confirmation code at a TTY.
import { userInfo } from "node:os"
import {
  type ApprovalStage,
  approvalSubject,
  commandSetHash,
  Factory,
  factoryLayout,
  gateRunner,
  HookEngine,
  isTrusted,
  loadGatesConfig,
  readJson,
  recordApproval,
  recordWaiver,
  trustProject,
  verifyControl,
  writeJson,
} from "@heretek-ai/es-core"
import { type Args, flag, parseExpiry } from "./args.ts"
import { type ConfirmIO, confirmWithCode } from "./tty.ts"

export interface HumanContext {
  readonly root: string
  readonly io: ConfirmIO
  readonly stateDir?: string
  readonly print: (text: string) => void
}

const user = () => userInfo().username
const factoryFor = (context: HumanContext) =>
  new Factory(context.root, {
    gates: gateRunner(context.stateDir ? { stateDir: context.stateDir } : {}),
    ...(context.stateDir ? { stateDir: context.stateDir } : {}),
  })

export async function approve(context: HumanContext, args: Args): Promise<number> {
  const stage = args.positionals[0] as ApprovalStage | undefined
  if (stage !== "frontier" && stage !== "spec") {
    context.print("Usage: es approve <frontier|spec>")
    return 2
  }
  const subject = await approvalSubject(context.root, stage)
  const lines = [...subject.summary, "", ...subject.subject.map((item) => `${item.sha256.slice(0, 12)}  ${item.path}`)]
  if (!(await confirmWithCode(context.io, `Approve ${stage} as ${user()}`, lines))) {
    context.print("Cancelled; nothing was approved.")
    return 1
  }
  const record = await recordApproval(context.root, {
    stage,
    channel: "cli",
    ...(context.stateDir ? { stateDir: context.stateDir } : {}),
  })
  const pending =
    (await readJson<Array<{ stage: string }>>(factoryLayout(context.root).pending).catch(() => undefined)) ?? []
  await writeJson(
    factoryLayout(context.root).pending,
    pending.filter((item) => item.stage !== stage),
  )
  if (stage === "frontier") {
    const factory = factoryFor(context)
    if (!(await factory.read())) await factory.begin(`human:${record.approvedBy}`)
    if ((await factory.read())?.stage === "GRILL") await factory.beginResearch(`human:${record.approvedBy}`)
  }
  context.print(`Approved ${stage} (${record.subject.length} artifact(s)) as ${record.approvedBy}.`)
  return 0
}

export async function trust(context: HumanContext, args: Args): Promise<number> {
  const { config } = await loadGatesConfig(context.root)
  const gates = await commandSetHash(context.root, config.commands)
  const hooks = (
    await HookEngine.create({
      root: context.root,
      ...(context.stateDir ? { stateDir: context.stateDir } : {}),
      audit: false,
    })
  ).status()
  const lines = [...gates.lines, ...hooks.projectLines]
  const trusted =
    (await isTrusted(context.root, gates.hash, context.stateDir)) &&
    (!hooks.projectHash || (await isTrusted(context.root, hooks.projectHash, context.stateDir, "hooks")))
  if (args.flags.show || lines.length === 0) {
    context.print(
      lines.length
        ? `${trusted ? "Trusted" : "NOT trusted"}:\n${lines.join("\n")}`
        : "No gate commands or project hooks detected.",
    )
    return 0
  }
  if (trusted) {
    context.print("These gate commands and hooks are already trusted.")
    return 0
  }
  if (
    !(await confirmWithCode(context.io, "Trust these gate commands and project hooks (they run project code)", lines))
  ) {
    context.print("Cancelled.")
    return 1
  }
  const options = context.stateDir ? { stateDir: context.stateDir } : {}
  await trustProject(context.root, gates.hash, gates.lines, options)
  if (hooks.projectHash)
    await trustProject(context.root, hooks.projectHash, hooks.projectLines, { ...options, kind: "hooks" })
  context.print(`Trusted ${lines.length} line(s) for ${context.root}.`)
  return 0
}

export async function waive(context: HumanContext, args: Args): Promise<number> {
  const rule = args.positionals[0]
  const reason = flag(args, "reason")
  const expires = flag(args, "expires") ?? "7d"
  if (!rule || !reason) {
    context.print(
      'Usage: es waive <rule-glob> --reason "why this is acceptable" [--files <glob>] [--expires 7d] [--id name]',
    )
    return 2
  }
  const files = flag(args, "files") ?? "**"
  const expiresAt = parseExpiry(expires)
  const id =
    flag(args, "id") ??
    `${rule
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()}-${Date.now().toString(36)}`.slice(0, 64)
  const lines = [`Rule:    ${rule}`, `Files:   ${files}`, `Reason:  ${reason}`, `Expires: ${expiresAt.toISOString()}`]
  if (!(await confirmWithCode(context.io, `Grant waiver ${id}`, lines))) {
    context.print("Cancelled.")
    return 1
  }
  const waiver = await recordWaiver(context.root, {
    id,
    rule,
    files,
    reason,
    expiresAt,
    channel: "cli",
    ...(context.stateDir ? { stateDir: context.stateDir } : {}),
  })
  context.print(`Waiver ${waiver.id} granted until ${waiver.expiresAt}.`)
  return 0
}

export async function resume(context: HumanContext, args: Args): Promise<number> {
  const factory = factoryFor(context)
  const state = await factory.read()
  if (state?.stage !== "HALTED") {
    context.print("The factory is not halted.")
    return 1
  }
  const control = await verifyControl(context.root)
  const raise = flag(args, "raise-ceiling")
  const lines = [
    `Halted: ${state.halt?.reason}`,
    `Spend:  $${state.spend.usd.toFixed(2)}${state.spend.estimated ? " (estimated)" : ""} of $${state.spendCeilingUSD ?? "?"}`,
    ...(control.clean
      ? []
      : [
          "Control-file drift (resuming with --accept-drift re-baselines):",
          ...control.violations.map((item) => `  ${item}`),
        ]),
    ...(raise ? [`New spend ceiling: $${raise}`] : []),
    ...(args.flags["extend-runtime"] ? ["Runtime cap restarts now."] : []),
  ]
  if (!(await confirmWithCode(context.io, "Resume the factory", lines))) {
    context.print("Cancelled.")
    return 1
  }
  const resumed = await factory.resume(user(), {
    ...(args.flags["accept-drift"] ? { acceptControlDrift: true } : {}),
    ...(raise ? { raiseCeilingUSD: Number(raise) } : {}),
    ...(args.flags["extend-runtime"] ? { extendRuntime: true } : {}),
  })
  context.print(`Resumed at ${resumed.stage}.`)
  return 0
}

/** Record a PR opened by hand (when no PR opener was available at release). */
export async function recordPr(context: HumanContext, args: Args): Promise<number> {
  const url = args.positionals[0]
  if (!url) {
    context.print("Usage: es factory pr <url>")
    return 2
  }
  if (!(await confirmWithCode(context.io, "Record the release PR", [url]))) return 1
  const state = await factoryFor(context).recordPr(user(), url)
  context.print(`Recorded ${url}; factory is ${state.stage}.`)
  return 0
}
