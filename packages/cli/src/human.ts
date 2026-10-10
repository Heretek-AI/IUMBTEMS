// Human-only commands: approve, trust, waive, resume, rebaseline. Each previews exactly
// what will be signed, then requires the human passphrase at a TTY.
import { userInfo } from "node:os"
import {
  ApprovalError,
  type ApprovalStage,
  type Args,
  applyConfigSet,
  approvalSubject,
  approveStage,
  ClaimStore,
  ConfigError,
  type ConfigSetPlan,
  commandSetHash,
  engineKeyPath,
  engineSignedFiles,
  Factory,
  flag,
  gateRunner,
  HookEngine,
  hashJson,
  initFromPreset,
  isTrusted,
  loadGatesConfig,
  planConfigSet,
  rebaseline,
  recordRetraction,
  recordWaiver,
  researchCache,
  run,
  SELF_DOGFOOD_BASE_BRANCH,
  SELF_DOGFOOD_SPEND_CEILING_USD,
  signEngineFile,
  stateDir,
  trustProject,
  verifyControl,
  verifyEngineFile,
} from "@heretek-ai/es-core"
import { parseExpiry } from "./args.ts"
import { type ConfirmIO, confirmHuman } from "./tty.ts"

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

/** ADR 0002 I3: a preview older than this is refused instead of signed. */
export const APPROVAL_PREVIEW_TTL_MS = 120_000

/** Attempt limiting for one human confirm (ADR 0002 I4, per state dir, shared with the TUI). */
const confirmOptions = (context: HumanContext, stage: string) => ({
  ...(context.stateDir ? { stateDir: context.stateDir } : {}),
  root: context.root,
  stage,
  channel: "cli",
})

export async function approve(context: HumanContext, args: Args): Promise<number> {
  const stage = args.positionals[0] as ApprovalStage | undefined
  if (stage !== "frontier" && stage !== "spec") {
    context.print("Usage: es approve <frontier|spec>")
    return 2
  }
  const subject = await approvalSubject(context.root, stage)
  // ADR 0002 I3: bind the sign to what was previewed. The hash and the
  // preview time are captured before the passphrase prompt; approveStage
  // re-derives the subject and refuses a mismatch, and a stale preview is
  // refused before anything is signed.
  const expectedSubjectHash = hashJson(subject.subject)
  const previewedAt = Date.now()
  const lines = [...subject.summary, "", ...subject.subject.map((item) => `${item.sha256.slice(0, 12)}  ${item.path}`)]
  const signer = await confirmHuman(context.io, `Approve ${stage} as ${user()}`, lines, confirmOptions(context, stage))
  if (!signer) {
    context.print("Cancelled; nothing was approved.")
    return 1
  }
  try {
    if (Date.now() - previewedAt > APPROVAL_PREVIEW_TTL_MS) {
      context.print(`The ${stage} preview expired (over 120 s old); run \`es approve ${stage}\` again.`)
      return 1
    }
    // One code path for every surface (#117): the service records, clears
    // pending and (for frontier) begins research under its own locks.
    const { record, alreadyApproved } = await approveStage(context.root, {
      stage,
      channel: "cli",
      signer,
      expectedSubjectHash,
      ...(context.stateDir ? { stateDir: context.stateDir } : {}),
    })
    context.print(
      `${alreadyApproved ? "Already approved" : "Approved"} ${stage} (${record.subject.length} artifact(s)) as ${record.approvedBy}.`,
    )
    return 0
  } catch (error) {
    if (!(error instanceof ApprovalError)) throw error
    context.print(`What was previewed changed; run \`es approve ${stage}\` again.`)
    return 1
  } finally {
    signer.destroy()
  }
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
  const signer = await confirmHuman(
    context.io,
    "Trust these gate commands and project hooks (they run project code)",
    lines,
    confirmOptions(context, "trust"),
  )
  if (!signer) {
    context.print("Cancelled.")
    return 1
  }
  const options = { ...(context.stateDir ? { stateDir: context.stateDir } : {}), signer }
  await trustProject(context.root, gates.hash, gates.lines, options)
  if (hooks.projectHash)
    await trustProject(context.root, hooks.projectHash, hooks.projectLines, { ...options, kind: "hooks" })
  context.print(`Trusted ${lines.length} line(s) for ${context.root}.`)
  return 0
}

/** Accept hand edits to pinned control files (gates.json, config.json, frontier) as the human's own. */
export async function rebaselineControl(context: HumanContext): Promise<number> {
  const check = await verifyControl(context.root)
  if (check.clean) {
    context.print(
      check.hasBaseline ? "Control files match the baseline." : "No baseline yet; the first approval creates one.",
    )
    return 0
  }
  if (
    !(await confirmHuman(
      context.io,
      `Accept these control-file changes as ${user()}`,
      [...check.violations],
      confirmOptions(context, "rebaseline"),
    ))
  ) {
    context.print("Cancelled; the baseline is unchanged.")
    return 1
  }
  await rebaseline(context.root, `human:${user()} (es rebaseline)`)
  context.print(`Re-baselined ${check.violations.length} control-file change(s).`)
  return 0
}

/**
 * Human-only: verify the signed sidecars on engine-owned files, and with
 * `--sign` re-sign reviewed files after the passphrase confirm (adopts legacy
 * pre-sidecar files and recovers tampered ones the human has reviewed).
 */
export async function reseal(context: HumanContext, sign: boolean): Promise<number> {
  const { exists } = await import("@heretek-ai/es-core")
  const files = engineSignedFiles(context.root)
  const present = async (file: string) => exists(file)
  const targets = (await Promise.all(files.map(async (file) => ((await present(file)) ? file : undefined)))).filter(
    (file): file is string => file !== undefined,
  )
  if (!targets.length) {
    context.print("No engine-signed files yet (no factory run here).")
    return 0
  }
  const problems = new Map<string, string>()
  for (const file of targets) {
    const problem = await verifyEngineFile(file, context.stateDir)
    if (problem) problems.set(file, problem)
  }
  const rel = (file: string) => file.slice(context.root.length + 1)
  const key = engineKeyPath(context.stateDir ?? stateDir())
  context.print(`Engine key: ${key}`)
  if ([...problems.values()].includes("missing engine key")) {
    // Signing here would mint a new key and break every reader that uses the real one.
    context.print(
      `This shell cannot see the engine key (no file at ${key}), so it can neither verify nor re-sign. ` +
        "Run es reseal where the plugin's state dir is visible (set ES_STATE_DIR to the plugin's stateDir).",
    )
    return 1
  }
  if (!sign) {
    for (const file of targets) context.print(`${rel(file)}: ${problems.get(file) ?? "ok"}`)
    if (problems.size) {
      context.print("Review the files above, then a human re-signs them with `es reseal --sign`.")
      return 1
    }
    return 0
  }
  if (!problems.size) {
    context.print("Every sidecar verifies; nothing to sign.")
    return 0
  }
  const lines = [...problems].map(([file, problem]) => `${rel(file)}: ${problem}`)
  if (
    !(await confirmHuman(
      context.io,
      `Re-sign ${problems.size} engine file(s) as ${user()} (review them first: a mismatch can mean tampering)`,
      lines,
      confirmOptions(context, "reseal"),
    ))
  ) {
    context.print("Cancelled; nothing was signed.")
    return 1
  }
  for (const file of problems.keys()) await signEngineFile(file, context.stateDir)
  context.print(`Re-signed ${problems.size} engine file(s).`)
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
  const signer = await confirmHuman(context.io, `Grant waiver ${id}`, lines, confirmOptions(context, "waive"))
  if (!signer) {
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
    signer,
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
  if (!(await confirmHuman(context.io, "Resume the factory", lines, confirmOptions(context, "resume")))) {
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
  if (!(await confirmHuman(context.io, "Record the release PR", [url], confirmOptions(context, "pr")))) return 1
  const state = await factoryFor(context).recordPr(user(), url)
  context.print(`Recorded ${url}; factory is ${state.stage}.`)
  return 0
}

/**
 * Seed a self-dogfood run from a preset and a GitHub issue (human-only: it
 * writes factory control files). Pulls the issue body as the idea, writes
 * `.factory/` from the preset, and reminds the human about trust, the
 * spend ceiling and the frontier/spec approvals.
 */
export async function factoryInit(context: HumanContext, args: Args): Promise<number> {
  const preset = flag(args, "preset")
  const issueRaw = flag(args, "issue")
  const issue = issueRaw !== undefined ? Number(issueRaw) : Number.NaN
  if (preset !== "self-dogfood" || !Number.isInteger(issue) || issue <= 0) {
    context.print("Usage: es factory init --preset self-dogfood --issue <n>")
    return 2
  }
  const fetched = await run(["gh", "issue", "view", String(issue), "--json", "title,body"], {
    cwd: context.root,
    timeoutMs: 30_000,
  }).catch(() => undefined)
  if (fetched?.code !== 0) {
    context.print(`Cannot read issue #${issue} (gh issue view failed; is gh authenticated?).`)
    return 1
  }
  const { title, body } = JSON.parse(fetched.stdout) as { title: string; body: string }
  const lines = [
    `Preset: self-dogfood (release base ${SELF_DOGFOOD_BASE_BRANCH}, gates: bun run check + docs:check)`,
    `Issue #${issue}: ${title}`,
    "Writes: .factory/config.json, .factory/gates.json, .factory/roadmap.json, .factory/notes/idea-<n>.md",
  ]
  if (
    !(await confirmHuman(context.io, `Start a self-dogfood run from #${issue}`, lines, confirmOptions(context, "init")))
  ) {
    context.print("Cancelled; nothing was written.")
    return 1
  }
  const { written } = await initFromPreset(context.root, preset, { issue, title, body }, { actor: `human:${user()}` })
  context.print(
    [
      `Seeded a self-dogfood run from #${issue} (${written.length} file(s)):`,
      ...written.map((file) => `  ${file}`),
      `Next: es trust (gate commands), then /grill with a $${SELF_DOGFOOD_SPEND_CEILING_USD} spend ceiling — keep baseBranch "${SELF_DOGFOOD_BASE_BRANCH}" when the grill rewrites the roadmap — then approve the frontier and spec.`,
    ].join("\n"),
  )
  return 0
}

/** Record that a cached source was retracted or revised; every claim citing it degrades. */
export async function retract(context: HumanContext, args: Args): Promise<number> {
  const source = args.positionals[0]
  const event = flag(args, "event")?.toUpperCase()
  const note = flag(args, "note") ?? ""
  const supersedes = flag(args, "supersedes")
  if (
    !source ||
    !/^[0-9a-f]{64}$/.test(source) ||
    (event !== "RETRACTED" && event !== "REVISED") ||
    (supersedes !== undefined && !/^[0-9a-f]{64}$/.test(supersedes))
  ) {
    context.print(
      'Usage: es research retract <sha256> --event retracted|revised [--note "why"] [--supersedes <sha256>]',
    )
    return 2
  }
  const store = await ClaimStore.load(context.root)
  const affected = store.citing(source)
  const cached = await researchCache(context.root, context.stateDir ?? stateDir()).get(source)
  const to = event === "RETRACTED" ? "STALE" : "SUSPECT"
  const lines = [
    `Source:  ${source}`,
    `         ${cached ? `${cached.meta.url} (retrieved ${cached.meta.retrieved})` : "not in this project's cache"}`,
    `Event:   ${event}${note ? ` — ${note}` : ""}`,
    ...(supersedes ? [`Replaced by: ${supersedes}`] : []),
    `Claims citing it: ${affected.length} (they become ${to})`,
    ...affected.slice(0, 10).map((claim) => `  - ${claim.statement.slice(0, 90)}`),
  ]
  if (
    !(await confirmHuman(
      context.io,
      `Record source ${event.toLowerCase()} as ${user()}`,
      lines,
      confirmOptions(context, "retract"),
    ))
  ) {
    context.print("Cancelled; nothing was recorded.")
    return 1
  }
  await recordRetraction(context.root, {
    source,
    event,
    note,
    by: `human:${user()}`,
    ...(supersedes ? { supersedes } : {}),
  })
  context.print(`Recorded: ${affected.length} claim(s) citing ${source.slice(0, 16)} are now ${to}.`)
  return 0
}

const show = (value: unknown) => (value === undefined ? "(unset)" : JSON.stringify(value))

/** Set one config key in the project (default) or global layer: schema-validated, previewed, passphrase-confirmed. */
export async function configSet(context: HumanContext, args: Args): Promise<number> {
  const [key, value] = args.positionals
  if (!key || value === undefined) {
    context.print("Usage: es config set <key> <value> [--global]   (value parses as JSON when it can; null unsets)")
    return 2
  }
  const layer = args.flags.global === true ? "global" : "project"
  let plan: ConfigSetPlan
  try {
    plan = await planConfigSet(context.root, { key, value, layer })
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    context.print(`Refused: ${error.message}`)
    return 1
  }
  if (plan.unchanged) {
    context.print(`${key} is already ${show(plan.after)} in the ${layer} config; nothing to change.`)
    return 0
  }
  const lines = [
    `Layer:  ${layer} (${plan.file})`,
    `${key}: ${show(plan.before)} → ${show(plan.after)}`,
    ...(plan.drift.length
      ? [
          "Your pending hand edit to .factory/config.json is accepted along with it:",
          ...plan.drift.map((item) => `  ${item}`),
        ]
      : []),
    ...(layer === "project" ? ["The control baseline is re-recorded for .factory/config.json."] : []),
  ]
  if (!(await confirmHuman(context.io, `Set ${key} as ${user()}`, lines, confirmOptions(context, "config-set")))) {
    context.print("Cancelled; the config is unchanged.")
    return 1
  }
  try {
    await applyConfigSet(context.root, plan, { actor: `human:${user()}` })
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    context.print(`Refused: ${error.message}`)
    return 1
  }
  context.print(`Set ${key} = ${show(plan.after)} in ${plan.file}.`)
  return 0
}
