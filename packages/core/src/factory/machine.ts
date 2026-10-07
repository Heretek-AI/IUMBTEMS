// The code-enforced factory: GRILL → RESEARCH → SPEC → BUILD ⇄ QA → RELEASE → DONE,
// with HALTED reachable from anywhere and left only by a human.
//
// Invariants enforced here (not in prompts):
// - Transitions out of GRILL and SPEC need a signed human approval whose
//   artifact hashes still match the files on disk.
// - Seat-specific operations check the calling agent's seat by agent ID.
// - Gates run in the phase worktree; a phase only reaches QA through the
//   gated `complete`, and only both QA seats (or the manager's tiebreak) pass it.
// - Failure policy: 3 attempts, one replan, 2 more attempts, then halt.
// - Every operation first checks the STOP kill-file, control-file drift,
//   the spend ceiling and the runtime cap, halting on any breach.
// - Side effects (worktrees, commits, branch moves, PRs) are journaled.
import { randomBytes } from "node:crypto"
import { readFile, symlink } from "node:fs/promises"
import path from "node:path"
import { seatOf } from "../agents/registry.ts"
import { readApproval, verifyApproval } from "../approval/record.ts"
import { appendAuditEntry } from "../audit/chain.ts"
import { factoryLayout } from "../layout.ts"
import { auditMarkdown, formatCoverage } from "../research/auditor.ts"
import { researchCache } from "../research/ops.ts"
import { type Frontier, FrontierSchema } from "../schema/frontier.ts"
import { type AcceptanceCriterion, parseGoalMarkdown } from "../schema/goal.ts"
import { RoadmapSchema } from "../schema/roadmap.ts"
import { rebaseline, verifyControl } from "../trust/control.ts"
import { checkStopFile } from "../trust/stop.ts"
import { appendLine, exists, readJson, withLock, writeJson } from "../util/fs.ts"
import { sha256 } from "../util/hash.ts"
import { run, splitCommand } from "../util/proc.ts"
import * as Git from "../worktree/git.ts"
import { once } from "./journal.ts"
import {
  DEFAULT_LIMITS,
  type FactoryLimits,
  type FactoryState,
  FactoryStateSchema,
  type PhaseRuntime,
  type Stage,
  type Verdict,
} from "./state.ts"

/** The operation was refused; state is unchanged. */
export class FactoryError extends Error {}
/** The factory is halted; only a human can resume it. */
export class FactoryHalted extends FactoryError {}

export interface GateFindingLike {
  readonly file: string
  readonly line?: number
  readonly rule: string
  readonly severity: "error" | "warning"
  readonly message: string
  readonly fixHint?: string
}

export interface GateRunLike {
  readonly passed: boolean
  readonly findings: readonly GateFindingLike[]
  readonly summary: string
  /** Test files that failed in this run (for red-first evidence). */
  readonly failedTests?: readonly string[]
  /** A test command failed (red), even if no file was attributed. */
  readonly testsFailed?: boolean
}

export interface GateRequest {
  readonly root: string
  readonly dir: string
  readonly scope: "touched" | "full"
  readonly touched?: readonly string[]
  readonly base?: string
  readonly phaseId?: string
  readonly runId?: string
}

export type GateRunner = (request: GateRequest) => Promise<GateRunLike>

export interface PrRequest {
  readonly root: string
  readonly branch: string
  readonly base: string
  readonly title: string
  readonly body: string
}

export interface PrOpener {
  readonly id: string
  available(root: string): Promise<boolean>
  open(request: PrRequest): Promise<{ url: string }>
}

export interface FactoryDeps {
  readonly gates: GateRunner
  readonly pr?: PrOpener
  readonly limits?: Partial<FactoryLimits>
  readonly stateDir?: string
  readonly now?: () => Date
  /** Require a red test run before `complete` (failing test first). Default true. */
  readonly requireRedFirst?: boolean
}

export interface CompleteResult {
  readonly ok: boolean
  readonly summary: string
  readonly findings: readonly GateFindingLike[]
  readonly criteria: ReadonlyArray<{ id: string; ok: boolean; detail: string }>
}

// run-20261007-043122-ab12: the ISO timestamp to the second, without separators.
const newRunId = (now: Date) =>
  `run-${now.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").replace("T", "-")}-${randomBytes(2).toString("hex")}`

const TEST_FILE =
  /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/

export class Factory {
  private readonly limits: FactoryLimits
  private readonly layout: ReturnType<typeof factoryLayout>

  constructor(
    readonly root: string,
    private readonly deps: FactoryDeps,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits }
    this.layout = factoryLayout(root)
  }

  private now() {
    return (this.deps.now ?? (() => new Date()))()
  }

  // ------------------------------------------------------------ state io

  async read(): Promise<FactoryState | undefined> {
    const raw = await readJson(this.layout.state)
    return raw === undefined ? undefined : FactoryStateSchema.parse(raw)
  }

  private fresh(): FactoryState {
    const at = this.now().toISOString()
    return {
      version: 1,
      runId: newRunId(this.now()),
      stage: "GRILL",
      createdAt: at,
      updatedAt: at,
      spend: { usd: 0, estimated: false, events: 0 },
      phases: [],
    }
  }

  private async save(state: FactoryState) {
    state.updatedAt = this.now().toISOString()
    await writeJson(this.layout.state, FactoryStateSchema.parse(state))
  }

  private audit(actor: string, action: string, payload: Record<string, unknown> = {}) {
    return appendAuditEntry(this.root, { actor, action, payload })
  }

  /** Load-modify-save under the state lock. Guards run first unless the op is human-only. */
  private async mutate<T>(
    actor: string,
    fn: (state: FactoryState) => Promise<T> | T,
    options: { guard?: boolean; create?: boolean } = {},
  ): Promise<T> {
    return withLock(this.layout.state, async () => {
      const existing = await this.read()
      if (!existing && !options.create)
        throw new FactoryError("No factory run here yet. Start one with /grill (or `es factory begin`).")
      const state = existing ?? this.fresh()
      if (options.guard !== false) {
        const halted = await this.guard(state, actor)
        if (halted) {
          await this.save(state)
          throw new FactoryHalted(`Factory halted: ${state.halt?.reason}`)
        }
      }
      const result = await fn(state)
      await this.save(state)
      return result
    })
  }

  /** Returns true when the state is (or just became) HALTED. */
  private async guard(state: FactoryState, actor: string): Promise<boolean> {
    if (state.stage === "HALTED") return true
    const halt = async (reason: string) => {
      state.halt = { reason, at: this.now().toISOString(), from: state.stage }
      state.stage = "HALTED"
      await this.audit(actor, "factory.halt", { reason })
      return true
    }
    const stop = await checkStopFile(this.root)
    if (stop.stopped) return halt(`STOP file: ${stop.reason}`)
    const control = await verifyControl(this.root)
    if (!control.clean) return halt(`control files changed outside a human action: ${control.violations.join("; ")}`)
    if (state.spendCeilingUSD !== undefined && state.spend.usd >= state.spendCeilingUSD)
      return halt(
        `spend ceiling reached: $${state.spend.usd.toFixed(2)}${state.spend.estimated ? " (estimated)" : ""} of $${state.spendCeilingUSD}`,
      )
    if (
      state.autonomyStartedAt &&
      this.now().getTime() - Date.parse(state.autonomyStartedAt) > this.limits.maxRuntimeMs
    )
      return halt(`autonomous runtime cap of ${Math.round(this.limits.maxRuntimeMs / 3_600_000)}h reached`)
    return false
  }

  private requireSeat(agentId: string | undefined, ...seats: string[]) {
    const seat = seatOf(agentId)
    if (!seat || !seats.includes(seat))
      throw new FactoryError(
        `Only the ${seats.join(" or ")} seat may do this (called by ${agentId ?? "unknown agent"}).`,
      )
  }

  private requireStage(state: FactoryState, ...stages: Stage[]) {
    if (!stages.includes(state.stage))
      throw new FactoryError(`Not allowed in stage ${state.stage} (needs ${stages.join(" or ")}).`)
  }

  private active(state: FactoryState): PhaseRuntime {
    const phase = state.phases.find((item) => item.id === state.activePhase)
    if (!phase) throw new FactoryError("No active phase.")
    return phase
  }

  // ------------------------------------------------------------ grill

  async begin(actor = "system"): Promise<FactoryState> {
    return this.mutate(
      actor,
      async (state) => {
        if (state.stage !== "GRILL" || state.phases.length)
          throw new FactoryError(`A run already exists (${state.runId}, ${state.stage}).`)
        await this.audit(actor, "factory.begin", { runId: state.runId })
        return state
      },
      { create: true },
    )
  }

  /** Grill writes the design tree through this (agents cannot write the control file directly). */
  async writeFrontier(agentId: string | undefined, frontier: unknown): Promise<Frontier> {
    this.requireSeat(agentId, "grill", "factory")
    return this.mutate(
      `agent:${agentId}`,
      async (state) => {
        this.requireStage(state, "GRILL")
        const parsed = FrontierSchema.parse(frontier)
        await writeJson(this.layout.frontier, parsed)
        await rebaseline(this.root, `agent:${agentId} via es_frontier_write`)
        await this.audit(`agent:${agentId}`, "frontier.write", { settled: parsed.settled, nodes: parsed.nodes.length })
        return parsed
      },
      { create: true },
    )
  }

  async beginResearch(actor: string): Promise<FactoryState> {
    return this.mutate(actor, async (state) => {
      this.requireStage(state, "GRILL")
      const check = await verifyApproval(this.root, "frontier", { stateDir: this.deps.stateDir })
      if (!check.ok) throw new FactoryError(check.reason)
      state.spendCeilingUSD = check.record.spendCeilingUSD
      state.stage = "RESEARCH"
      await this.audit(actor, "stage.research", { spendCeilingUSD: state.spendCeilingUSD })
      return state
    })
  }

  // ------------------------------------------------------------ research → spec

  async completeResearch(agentId: string | undefined): Promise<FactoryState> {
    this.requireSeat(agentId, "factory")
    return this.mutate(`agent:${agentId}`, async (state) => {
      this.requireStage(state, "RESEARCH")
      const report = await readFile(this.layout.researchReport, "utf8").catch(() => undefined)
      if (report === undefined)
        throw new FactoryError("Research is not done: .factory/research/REPORT.md does not exist.")
      const cache = researchCache(this.root)
      const audit = await auditMarkdown(report, cache)
      await writeJson(path.join(this.layout.research, "coverage.json"), {
        ...audit.coverage,
        passed: audit.passed,
        at: this.now().toISOString(),
      })
      if (!audit.passed)
        throw new FactoryError(
          `The research report does not pass the epistemic audit.\n${formatCoverage(audit)}\nFix or prune the claims (es_research_audit with prune:true), then try again.`,
        )
      // Keep only the evidence the report cites, so the tracked cache stays small.
      const removed = await cache.prune(new Set(audit.cited))
      state.stage = "SPEC"
      await this.audit(`agent:${agentId}`, "stage.spec", {
        reportHash: sha256(report),
        coverage: audit.coverage,
        prunedSources: removed.length,
      })
      return state
    })
  }

  // ------------------------------------------------------------ spec → build

  async startBuild(agentId: string | undefined): Promise<FactoryState> {
    this.requireSeat(agentId, "factory")
    return this.mutate(`agent:${agentId}`, async (state) => {
      this.requireStage(state, "SPEC")
      const check = await verifyApproval(this.root, "spec", { stateDir: this.deps.stateDir })
      if (!check.ok) throw new FactoryError(check.reason)
      if (!(await Git.isRepo(this.root))) throw new FactoryError("The project must be a git repository to build.")
      const roadmap = RoadmapSchema.parse(JSON.parse(await readFile(this.layout.roadmap, "utf8")))
      if (roadmap.phases.length > this.limits.maxPhases)
        throw new FactoryError(`Roadmap exceeds ${this.limits.maxPhases} phases.`)
      const hashes = new Map(check.record.subject.map((item) => [item.path, item.sha256]))
      state.phases = roadmap.phases.map((phase) => ({
        id: phase.id,
        title: phase.title,
        status: "pending" as const,
        goalHash: hashes.get(`.factory/specs/${phase.id}/GOAL.md`)!,
        failures: 0,
        replanned: false,
        qa: {},
        history: [],
      }))
      state.baseBranch = roadmap.baseBranch ?? (await Git.currentBranch(this.root)) ?? "main"
      state.runBranch = `factory/${state.runId}/integration`
      await this.ensureExcludes()
      const base = await Git.revParse(this.root, state.baseBranch)
      await once(this.root, `${state.runId}:run-branch`, async () => {
        await Git.setBranch(this.root, state.runBranch!, base)
        return { base }
      })
      state.autonomyStartedAt = this.now().toISOString()
      state.stage = "BUILD"
      await this.audit(`agent:${agentId}`, "stage.build", { phases: state.phases.map((phase) => phase.id), base })
      await this.activate(state, state.phases[0]!)
      return state
    })
  }

  private async ensureExcludes() {
    const exclude = path.join((await Git.git(this.root, ["rev-parse", "--git-path", "info/exclude"])).stdout.trim())
    const file = path.isAbsolute(exclude) ? exclude : path.join(this.root, exclude)
    const current = await readFile(file, "utf8").catch(() => "")
    const wanted = [".factory/runtime/", ".factory/runs/", ".factory/worktrees/", ".factory/STOP"]
    const missing = wanted.filter((line) => !current.split("\n").includes(line))
    if (missing.length) await appendLine(file, `# epistemic-swarm\n${missing.join("\n")}`)
  }

  private async activate(state: FactoryState, phase: PhaseRuntime) {
    const dir = this.layout.worktree(phase.id)
    phase.branch = `factory/${state.runId}/phase-${phase.id}`
    phase.worktree = path.relative(this.root, dir).split(path.sep).join("/")
    const from = await Git.revParse(this.root, state.runBranch!)
    const result = await once(this.root, `${state.runId}:${phase.id}:worktree`, async () => {
      await Git.addWorktree(this.root, dir, phase.branch!, from)
      return { base: from }
    })
    // Share installed dependencies so gate tools resolve inside the worktree.
    for (const name of ["node_modules", ".venv", "venv"])
      if ((await exists(path.join(this.root, name))) && !(await exists(path.join(dir, name))))
        await symlink(path.join(this.root, name), path.join(dir, name), "dir").catch(() => undefined)
    phase.baseCommit = result.base
    phase.status = "building"
    phase.qa = {}
    state.activePhase = phase.id
    state.stage = "BUILD"
    phase.history.push({ at: this.now().toISOString(), event: "activated", notes: phase.branch })
  }

  /** Absolute path of the active phase worktree (for policy and gates). */
  async activeWorktree(): Promise<string | undefined> {
    const state = await this.read()
    const phase = state?.phases.find((item) => item.id === state.activePhase)
    return phase?.worktree && (state?.stage === "BUILD" || state?.stage === "QA")
      ? path.join(this.root, phase.worktree)
      : undefined
  }

  // ------------------------------------------------------------ build

  private async goalUnchanged(phase: PhaseRuntime) {
    const text = await readFile(this.layout.spec(phase.id), "utf8").catch(() => "")
    if (sha256(text) !== phase.goalHash)
      throw new FactoryError(
        `GOAL.md for ${phase.id} changed after approval. Only the manager's es_replan (after the third failure) may change it.`,
      )
    return parseGoalMarkdown(text)
  }

  /** Record a gate run made during BUILD (red test runs are the failing-test-first evidence). */
  async recordGateRun(agentId: string | undefined, result: GateRunLike): Promise<void> {
    await this.mutate(`agent:${agentId}`, (state) => {
      if (state.stage !== "BUILD") return
      const phase = this.active(state)
      const failed = result.failedTests ?? []
      const red = failed.length > 0 || result.testsFailed === true
      phase.history.push({
        at: this.now().toISOString(),
        event: red ? "tests-red" : result.passed ? "gates-green" : "gates-red",
        notes: failed.join(", "),
      })
    })
  }

  /** The programmer's gated completion: acceptance criteria and full gates in the worktree. */
  async complete(agentId: string | undefined): Promise<CompleteResult> {
    this.requireSeat(agentId, "programmer")
    const snapshot = await this.mutate(`agent:${agentId}`, async (state) => {
      this.requireStage(state, "BUILD")
      const phase = this.active(state)
      if (phase.status !== "building") throw new FactoryError(`Phase ${phase.id} is ${phase.status}, not building.`)
      const goal = await this.goalUnchanged(phase)
      return { phase: structuredClone(phase), goal, runId: state.runId }
    })
    const { phase, goal } = snapshot
    const dir = path.join(this.root, phase.worktree!)
    const changed = await Git.changedFiles(dir, phase.baseCommit!)
    const findings: GateFindingLike[] = []
    if (changed.length === 0)
      findings.push({
        file: ".",
        rule: "factory/no-changes",
        severity: "error",
        message: "The phase worktree has no changes.",
      })
    if (this.deps.requireRedFirst !== false) {
      if (!changed.some((file) => TEST_FILE.test(file)))
        findings.push({
          file: ".",
          rule: "tdd/test-change",
          severity: "error",
          message: "No test file changed in this phase.",
          fixHint: "Write a failing test for the slice first.",
        })
      if (!phase.history.some((entry) => entry.event === "tests-red"))
        findings.push({
          file: ".",
          rule: "tdd/red-first",
          severity: "error",
          message: "No failing test run was recorded before completion.",
          fixHint: "Run es_gates_run after writing the failing test, then implement until it passes.",
        })
    }
    const criteria = await this.checkCriteria(dir, goal.frontmatter.acceptance)
    for (const item of criteria.filter((entry) => !entry.ok))
      findings.push({ file: `GOAL.md#${item.id}`, rule: "acceptance/unmet", severity: "error", message: item.detail })
    const gates = await this.deps.gates({
      root: this.root,
      dir,
      scope: "full",
      base: phase.baseCommit,
      phaseId: phase.id,
      runId: snapshot.runId,
    })
    findings.push(...gates.findings)
    const ok = gates.passed && findings.every((finding) => finding.severity !== "error")
    if (!ok) {
      await this.mutate(`agent:${agentId}`, (state) => {
        this.active(state).history.push({
          at: this.now().toISOString(),
          event: "complete-refused",
          notes: `${findings.length} findings`,
        })
      })
      return { ok: false, summary: `Not complete: ${gates.summary}`, findings, criteria }
    }
    await this.mutate(`agent:${agentId}`, async (state) => {
      this.requireStage(state, "BUILD")
      const current = this.active(state)
      if (current.id !== phase.id || current.status !== "building" || current.failures !== phase.failures)
        throw new FactoryError("The phase changed while gates ran; call es_complete again.")
      const commit = await once(
        this.root,
        `${state.runId}:${phase.id}:attempt-${phase.failures + 1}:commit`,
        async () => {
          const sha = await Git.commitAll(dir, `factory(${phase.id}): ${phase.title} (attempt ${phase.failures + 1})`)
          return { sha: sha ?? (await Git.headCommit(dir)) }
        },
      )
      current.headCommit = commit.sha
      current.status = "qa"
      current.qa = {}
      state.stage = "QA"
      current.history.push({ at: this.now().toISOString(), event: "completed", notes: commit.sha })
      await this.audit(`agent:${agentId}`, "phase.complete", { phase: phase.id, commit: commit.sha })
    })
    return { ok: true, summary: `Phase ${phase.id} is complete and in QA.`, findings: gates.findings, criteria }
  }

  private async checkCriteria(dir: string, criteria: readonly AcceptanceCriterion[]) {
    const results: Array<{ id: string; ok: boolean; detail: string }> = []
    for (const criterion of criteria) {
      if (criterion.kind === "file") {
        const text = await readFile(path.join(dir, criterion.path), "utf8").catch(() => undefined)
        const ok = text !== undefined && (criterion.contains === undefined || text.includes(criterion.contains))
        results.push({
          id: criterion.id,
          ok,
          detail: ok
            ? "present"
            : `${criterion.path} missing${criterion.contains ? ` or lacks "${criterion.contains}"` : ""}`,
        })
      } else if (criterion.kind === "test") {
        const ok = await exists(path.join(dir, criterion.path))
        results.push({
          id: criterion.id,
          ok,
          detail: ok ? "test file present (runs in the full suite)" : `${criterion.path} does not exist`,
        })
      } else {
        const result = await run(splitCommand(criterion.command), { cwd: dir, timeoutMs: 300_000 }).catch(
          (error: Error) => error,
        )
        const ok = !(result instanceof Error) && result.code === 0
        results.push({
          id: criterion.id,
          ok,
          detail: ok
            ? "exit 0"
            : result instanceof Error
              ? result.message
              : `exit ${result.code}: ${(result.stderr || result.stdout).slice(-400)}`,
        })
      }
    }
    return results
  }

  // ------------------------------------------------------------ QA

  async qaVerdict(agentId: string | undefined, verdict: "pass" | "fail", notes: string): Promise<FactoryState> {
    this.requireSeat(agentId, "qa-functional", "qa-adversarial")
    return this.mutate(`agent:${agentId}`, async (state) => {
      this.requireStage(state, "QA")
      const phase = this.active(state)
      const entry: Verdict = { verdict, by: agentId!, at: this.now().toISOString(), notes }
      if (seatOf(agentId) === "qa-functional") phase.qa.functional = entry
      else phase.qa.adversarial = entry
      await this.audit(`agent:${agentId}`, "qa.verdict", { phase: phase.id, verdict })
      await this.settleQa(state, phase)
      return state
    })
  }

  async tiebreak(agentId: string | undefined, verdict: "pass" | "fail", notes: string): Promise<FactoryState> {
    this.requireSeat(agentId, "manager")
    return this.mutate(`agent:${agentId}`, async (state) => {
      this.requireStage(state, "QA")
      const phase = this.active(state)
      const { functional, adversarial } = phase.qa
      if (!functional || !adversarial || functional.verdict === adversarial.verdict)
        throw new FactoryError("A tiebreak is only possible when the two QA seats disagree.")
      phase.qa.tiebreak = { verdict, by: agentId!, at: this.now().toISOString(), notes }
      await this.audit(`agent:${agentId}`, "qa.tiebreak", { phase: phase.id, verdict })
      await this.settleQa(state, phase)
      return state
    })
  }

  private async settleQa(state: FactoryState, phase: PhaseRuntime) {
    const { functional, adversarial, tiebreak } = phase.qa
    if (!functional || !adversarial) return
    const outcome =
      functional.verdict === adversarial.verdict ? functional.verdict : tiebreak ? tiebreak.verdict : undefined
    if (!outcome) return
    if (outcome === "pass") await this.passPhase(state, phase)
    else
      await this.failPhase(
        state,
        phase,
        [functional, adversarial, tiebreak]
          .filter((item) => item?.verdict === "fail")
          .map((item) => item!.notes)
          .join(" | "),
      )
  }

  private async passPhase(state: FactoryState, phase: PhaseRuntime) {
    const runBranch = state.runBranch!
    await once(this.root, `${state.runId}:${phase.id}:merge`, async () => {
      const tip = await Git.revParse(this.root, runBranch)
      if (!(await Git.isAncestor(this.root, tip, phase.headCommit!)))
        throw new FactoryError(
          `Phase ${phase.id} does not descend from ${runBranch}; refusing a non-fast-forward merge.`,
        )
      await Git.setBranch(this.root, runBranch, phase.headCommit!)
      return { tip: phase.headCommit }
    })
    await once(this.root, `${state.runId}:${phase.id}:worktree-removed`, async () => {
      await Git.removeWorktree(this.root, path.join(this.root, phase.worktree!))
      return true
    })
    phase.status = "passed"
    phase.history.push({ at: this.now().toISOString(), event: "passed", notes: phase.headCommit ?? "" })
    await this.audit("system", "phase.pass", { phase: phase.id, commit: phase.headCommit })
    const next = state.phases.find((item) => item.status === "pending")
    if (next) await this.activate(state, next)
    else {
      state.activePhase = undefined
      state.stage = "RELEASE"
      await this.audit("system", "stage.release", {})
    }
  }

  private async failPhase(state: FactoryState, phase: PhaseRuntime, notes: string) {
    phase.failures += 1
    phase.qa = {}
    phase.history.push({ at: this.now().toISOString(), event: `failed-${phase.failures}`, notes })
    await this.audit("system", "phase.fail", { phase: phase.id, failures: phase.failures })
    if (phase.failures >= this.limits.maxFailuresPerPhase) {
      phase.status = "failed"
      state.halt = {
        reason: `phase ${phase.id} failed ${phase.failures} times (3 attempts, a replan, 2 more attempts)`,
        at: this.now().toISOString(),
        from: "BUILD",
      }
      state.stage = "HALTED"
      await this.audit("system", "factory.halt", { reason: state.halt.reason })
      return
    }
    if (phase.failures === this.limits.replanAfterFailures && !phase.replanned) {
      phase.status = "replanning"
      state.stage = "BUILD"
      return
    }
    phase.status = "building"
    state.stage = "BUILD"
  }

  /** After the third failure the manager rewrites GOAL.md and accepts it here (once). */
  async replan(agentId: string | undefined, notes: string): Promise<FactoryState> {
    this.requireSeat(agentId, "manager")
    return this.mutate(`agent:${agentId}`, async (state) => {
      this.requireStage(state, "BUILD")
      const phase = this.active(state)
      if (phase.status !== "replanning") throw new FactoryError(`Phase ${phase.id} is not awaiting a replan.`)
      const text = await readFile(this.layout.spec(phase.id), "utf8")
      const goal = parseGoalMarkdown(text)
      if (goal.frontmatter.phase !== phase.id) throw new FactoryError(`GOAL.md must declare phase "${phase.id}".`)
      const hash = sha256(text)
      if (hash === phase.goalHash) throw new FactoryError("GOAL.md is unchanged; a replan must revise the spec.")
      phase.goalHash = hash
      phase.replanned = true
      phase.status = "building"
      phase.history.push({ at: this.now().toISOString(), event: "replanned", notes })
      await this.audit(`agent:${agentId}`, "phase.replan", { phase: phase.id, goalHash: hash })
      return state
    })
  }

  // ------------------------------------------------------------ release

  async release(agentId: string | undefined): Promise<FactoryState> {
    this.requireSeat(agentId, "factory")
    const state = await this.mutate(`agent:${agentId}`, (current) => {
      this.requireStage(current, "RELEASE")
      return structuredClone(current)
    })
    const runBranch = state.runBranch!
    const dir = this.layout.worktree("release")
    const head = await Git.revParse(this.root, runBranch)
    await Git.addWorktree(this.root, dir, `factory/${state.runId}/release-check`, head)
    let gates: GateRunLike
    try {
      const base = await Git.revParse(this.root, state.baseBranch!)
      gates = await this.deps.gates({ root: this.root, dir, scope: "full", base, runId: state.runId })
    } finally {
      await Git.removeWorktree(this.root, dir)
      await Git.git(this.root, ["branch", "-D", `factory/${state.runId}/release-check`], { allowFail: true })
    }
    if (!gates.passed) throw new FactoryError(`Release gates failed: ${gates.summary}`)
    const pr = this.deps.pr
    if (!pr || !(await pr.available(this.root)))
      throw new FactoryError(
        `Gates are green on ${runBranch}, but no PR opener is available. Push the branch, open a PR to ${state.baseBranch}, then run \`es factory pr <url>\`.`,
      )
    const body = await this.prBody(state)
    const opened = await once(this.root, `${state.runId}:pr`, () =>
      pr.open({
        root: this.root,
        branch: runBranch,
        base: state.baseBranch!,
        title: `factory: ${state.phases
          .map((phase) => phase.title)
          .join("; ")
          .slice(0, 200)}`,
        body,
      }),
    )
    return this.mutate(`agent:${agentId}`, async (current) => {
      current.release = { prUrl: opened.url, at: this.now().toISOString(), head }
      current.stage = "DONE"
      await this.audit(`agent:${agentId}`, "release.pr", { url: opened.url, head })
      return current
    })
  }

  private async prBody(state: FactoryState) {
    const spec = await readApproval(this.root, "spec")
    const lines = [
      `Built by the Epistemic Swarm factory (run \`${state.runId}\`). A human reviews and merges; the factory never merges.`,
      "",
      "## Phases",
      ...state.phases.map(
        (phase) =>
          `- **${phase.id}**: ${phase.title} (${phase.failures} failed attempts${phase.replanned ? ", replanned" : ""})`,
      ),
      "",
      "## Provenance",
      `- Spec approved by ${spec?.approvedBy ?? "?"} via ${spec?.channel ?? "?"} at ${spec?.approvedAt ?? "?"}`,
      `- Spend: $${state.spend.usd.toFixed(2)}${state.spend.estimated ? " (estimated)" : ""} of $${state.spendCeilingUSD ?? "?"}`,
    ]
    return lines.join("\n")
  }

  /** Human fallback when no PR opener is available. */
  async recordPr(human: string, url: string): Promise<FactoryState> {
    return this.mutate(`human:${human}`, async (state) => {
      this.requireStage(state, "RELEASE")
      if (!/^https?:\/\//.test(url)) throw new FactoryError("Expected a PR URL.")
      state.release = { prUrl: url, at: this.now().toISOString() }
      state.stage = "DONE"
      await this.audit(`human:${human}`, "release.pr", { url })
      return state
    })
  }

  // ------------------------------------------------------------ spend, halt, resume

  async recordSpend(usd: number, estimated: boolean): Promise<FactoryState | undefined> {
    if (!(usd > 0)) return this.read()
    return withLock(this.layout.state, async () => {
      const state = await this.read()
      if (!state || state.stage === "HALTED" || state.stage === "DONE") return state
      state.spend.usd += usd
      state.spend.estimated ||= estimated
      state.spend.events += 1
      await this.guard(state, "system")
      await this.save(state)
      return state
    })
  }

  async halt(actor: string, reason: string): Promise<FactoryState> {
    return this.mutate(
      actor,
      async (state) => {
        if (state.stage === "HALTED") return state
        state.halt = { reason, at: this.now().toISOString(), from: state.stage }
        state.stage = "HALTED"
        await this.audit(actor, "factory.halt", { reason })
        return state
      },
      { guard: false },
    )
  }

  /** Human-only (CLI/TUI). Clears a halt after the cause is addressed. */
  async resume(
    human: string,
    options: { acceptControlDrift?: boolean; raiseCeilingUSD?: number; extendRuntime?: boolean } = {},
  ): Promise<FactoryState> {
    return this.mutate(
      `human:${human}`,
      async (state) => {
        if (state.stage !== "HALTED" || !state.halt) throw new FactoryError("The factory is not halted.")
        if ((await checkStopFile(this.root)).stopped) throw new FactoryError("Remove .factory/STOP first.")
        const control = await verifyControl(this.root)
        if (!control.clean) {
          if (!options.acceptControlDrift)
            throw new FactoryError(
              `Control files changed: ${control.violations.join("; ")}. Review them, then resume accepting the drift.`,
            )
          await rebaseline(this.root, `human:${human} (resume)`)
        }
        if (options.raiseCeilingUSD !== undefined) {
          if (!(options.raiseCeilingUSD > (state.spendCeilingUSD ?? 0)))
            throw new FactoryError("A raised ceiling must exceed the current one.")
          state.spendCeilingUSD = options.raiseCeilingUSD
        }
        if (state.spendCeilingUSD !== undefined && state.spend.usd >= state.spendCeilingUSD)
          throw new FactoryError(
            `Spend $${state.spend.usd.toFixed(2)} is at the ceiling $${state.spendCeilingUSD}; raise it to resume.`,
          )
        if (options.extendRuntime) state.autonomyStartedAt = this.now().toISOString()
        const failed = state.phases.find((phase) => phase.status === "failed")
        if (failed)
          throw new FactoryError(`Phase ${failed.id} exhausted its retries; revise the spec and start a new run.`)
        const from = state.halt.from
        await this.audit(`human:${human}`, "factory.resume", { from, reason: state.halt.reason, ...options })
        state.stage = from
        state.halt = undefined
        return state
      },
      { guard: false },
    )
  }
}
