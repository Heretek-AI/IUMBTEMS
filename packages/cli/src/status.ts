// `es status` and `es runs` (1.1.3, #58/#61): which run, in which project,
// is it working, waiting, stuck or done. The human view leads with one plain
// sentence; `--json` gives the same liveness to scripts and monitors.
import {
  ago,
  Factory,
  type FactoryState,
  formatHuman,
  gateRunner,
  headline,
  listRuns,
  loadEsConfig,
  type RunIndexEntry,
  readLiveness,
} from "@heretek-ai/es-core"
import type { Args } from "./args.ts"

export interface StatusContext {
  readonly root: string
  readonly stateDir: string
  readonly print: (text: string) => void
  readonly now?: () => Date
}

/** Another project's run counts as active when it changed this recently. */
const OTHER_RUN_WINDOW_MS = 10 * 60_000

/** The factory as the plugin would build it here: config extras feed the summary lines. */
export async function configuredFactory(root: string, stateDir: string): Promise<Factory> {
  const config = await loadEsConfig(root).then(
    (loaded) => loaded.config,
    () => undefined,
  )
  return new Factory(root, {
    gates: gateRunner({ stateDir }),
    stateDir,
    ...(config ? { researchDepth: config.research.depth } : {}),
    ...(config?.domainPack ? { domainPack: config.domainPack } : {}),
    ...(config?.audit.phase === "required" ? { auditPhase: "required" as const } : {}),
  })
}

/**
 * One line pointing at a run elsewhere when the cwd has none, or when another
 * project's run is more recently active than this one: monitors (human or
 * agent) otherwise watch the wrong run.
 */
export function otherRunHint(
  runs: readonly RunIndexEntry[],
  here: { readonly root: string; readonly state: FactoryState | undefined },
  now: Date,
): string | undefined {
  const other = runs.find(
    (run) =>
      run.root !== here.root &&
      run.stage !== "DONE" &&
      now.getTime() - Date.parse(run.updatedAt) < OTHER_RUN_WINDOW_MS &&
      (!here.state || run.updatedAt > here.state.updatedAt),
  )
  if (!other) return undefined
  const where = `${other.runId} (${other.stage}) in ${other.root}, updated ${ago({ now: now.toISOString() }, other.updatedAt)}`
  return here.state
    ? `Note: a more recently active run is ${where}. \`es status --run ${other.runId}\` shows it; \`es runs\` lists all.`
    : `A run is active elsewhere: ${where}. \`es status --run ${other.runId}\` shows it.`
}

export async function statusCommand(context: StatusContext, args: Args): Promise<number> {
  const now = context.now?.() ?? new Date()
  const factory = await configuredFactory(context.root, context.stateDir)
  const state = await factory.read()
  const liveness = await readLiveness(context.root, state, { now })
  const summary = await factory.summary(state)
  const hint = otherRunHint(await listRuns(context.stateDir), { root: context.root, state }, now)
  if (args.flags.json === true) {
    context.print(
      JSON.stringify(
        { headline: headline(state, liveness), liveness, summary, ...(hint ? { otherRun: hint } : {}) },
        null,
        2,
      ),
    )
    return 0
  }
  context.print([formatHuman(state, liveness, summary), ...(hint ? [hint] : [])].join("\n"))
  return 0
}

export async function runsCommand(context: StatusContext, args: Args): Promise<number> {
  const now = context.now?.() ?? new Date()
  const runs = (await listRuns(context.stateDir)).filter((run) => args.flags.all === true || run.stage !== "DONE")
  if (args.flags.json === true) {
    context.print(JSON.stringify(runs, null, 2))
    return 0
  }
  if (!runs.length) {
    context.print(
      args.flags.all === true
        ? "No indexed runs. Runs are indexed as they save (1.1.3+)."
        : "No active runs (`es runs --all` includes finished ones).",
    )
    return 0
  }
  const clock = { now: now.toISOString() }
  const width = Math.max(...runs.map((run) => run.stage.length))
  for (const run of runs)
    context.print(
      `${run.root === context.root ? "*" : " "} ${run.runId}  ${run.stage.padEnd(width)}  updated ${ago(clock, run.updatedAt).padEnd(8)}  ${run.root}`,
    )
  return 0
}
