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
import {
  claimVerdict,
  computeEpistemicScoreFromClaims,
  constitutionFromPack,
  loadDomainPack,
} from "../claims/constitution.ts"
import { readRetractions } from "../claims/degrade.ts"
import { buildDossier, writeDossier } from "../claims/dossier.ts"
import { claimsFromAudit } from "../claims/research.ts"
import { ClaimStore } from "../claims/store.ts"
import { factoryLayout } from "../layout.ts"
import { auditMarkdown, formatCoverage } from "../research/auditor.ts"
import { researchCache } from "../research/ops.ts"
import { type Frontier, FrontierSchema } from "../schema/frontier.ts"
import { type AcceptanceCriterion, parseGoalMarkdown } from "../schema/goal.ts"
import { RoadmapSchema } from "../schema/roadmap.ts"
import { rebaseline, verifyControl } from "../trust/control.ts"
import { checkStopFile } from "../trust/stop.ts"
import { appendLine, exists, readJson, relativeInside, withLock, writeJson } from "../util/fs.ts"
import { sha256 } from "../util/hash.ts"
import { run, splitCommand } from "../util/proc.ts"
import * as Git from "../worktree/git.ts"
import { once } from "./journal.ts"
import {
  type Audit,
  type AuditTarget,
  DEFAULT_LIMITS,
  describeTarget,
  FACTORY_STATE_VERSION,
  type FactoryLimits,
  type FactoryState,
  FactoryStateSchema,
  type PhaseRuntime,
  type Stage,
  type Verdict,
} from "./state.ts"
import { factorySummary } from "./summary.ts"
import { deferredFacts, diffFrontier, readFrontier, reopenedNodes, treeCounts } from "./tree.ts"

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
  /** Config research.depth, shown in the summary during RESEARCH (advisory). */
  readonly researchDepth?: number
  /** Config domainPack: the constitution RESEARCH must satisfy (unset keeps the legacy behaviour). */
  readonly domainPack?: string
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
    const raw = await readJson<{ version?: unknown }>(this.layout.state)
    if (raw === undefined) return undefined
    if (raw.version !== FACTORY_STATE_VERSION)
      throw new FactoryError(
        `.factory/runtime/state.json is a version ${String(raw.version)} run; 1.1 needs a fresh run (state version ${FACTORY_STATE_VERSION}). A human removes .factory/runtime/state.json (and an old frontier) and starts again with /grill.`,
      )
    return FactoryStateSchema.parse(raw)
  }

  private fresh(): FactoryState {
    const at = this.now().toISOString()
    return {
      version: FACTORY_STATE_VERSION,
      runId: newRunId(this.now()),
      stage: "GRILL",
      createdAt: at,
      updatedAt: at,
      spend: { usd: 0, estimated: false, events: 0 },
      phases: [],
      audits: [],
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

  /**
   * Grill writes the design tree through this (agents cannot write the control
   * file directly). Each write carries the full tree and is checked against the
   * previous one (see diffFrontier): no deleted nodes, no silent edits to
   * settled answers, no going back a round.
   */
  async writeFrontier(agentId: string | undefined, frontier: unknown): Promise<Frontier> {
    this.requireSeat(agentId, "grill", "factory")
    return this.mutate(
      `agent:${agentId}`,
      async (state) => {
        this.requireStage(state, "GRILL")
        const parsed = FrontierSchema.safeParse(frontier)
        if (!parsed.success)
          throw new FactoryError(
            `The frontier is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "frontier"}: ${issue.message}`).join("; ")}`,
          )
        const previous = await readFrontier(this.root).catch((error: Error) => {
          throw new FactoryError(error.message)
        })
        const problems = diffFrontier(previous, parsed.data)
        if (problems.length) throw new FactoryError(`The frontier write was refused:\n- ${problems.join("\n- ")}`)
        await writeJson(this.layout.frontier, parsed.data)
        await rebaseline(this.root, `agent:${agentId} via es_frontier_write`)
        const counts = treeCounts(parsed.data)
        await this.audit(`agent:${agentId}`, "frontier.write", {
          settled: parsed.data.settled,
          nodes: counts.total,
          round: counts.round,
          open: counts.open,
          deferred: counts.deferred,
          reopened: reopenedNodes(previous, parsed.data),
        })
        return parsed.data
      },
      { create: true },
    )
  }

  /** The `<factory-state>` block with the design tree's progress line. */
  async summary(state?: FactoryState): Promise<string> {
    const current = state ?? (await this.read())
    const frontier = await readFrontier(this.root).catch(() => undefined)
    return factorySummary(current, {
      ...(frontier ? { frontier } : {}),
      ...(this.deps.researchDepth !== undefined ? { researchDepth: this.deps.researchDepth } : {}),
      ...(this.deps.domainPack !== undefined ? { domainPack: this.deps.domainPack } : {}),
    })
  }

  async beginResearch(actor: string): Promise<FactoryState> {
    return this.mutate(actor, async (state) => {
      this.requireStage(state, "GRILL")
      this.requireAuditsClear(state)
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
      this.requireAuditsClear(state)
      const report = await readFile(this.layout.researchReport, "utf8").catch(() => undefined)
      if (report === undefined)
        throw new FactoryError("Research is not done: .factory/research/REPORT.md does not exist.")
      const cache = researchCache(this.root, this.deps.stateDir)
      const audit = await auditMarkdown(report, cache)
      await writeJson(this.layout.researchCoverage, {
        ...audit.coverage,
        passed: audit.passed,
        at: this.now().toISOString(),
      })
      if (!audit.passed)
        throw new FactoryError(
          `The research report does not pass the epistemic audit.\n${formatCoverage(audit)}\nFix or prune the claims (es_research_audit with prune:true), then try again.`,
        )
      // Facts the grill could not settle from the repo are research's to answer:
      // each deferred fact node must be cited on a (grounded) claim line.
      const frontier = await readFrontier(this.root).catch(() => undefined)
      const unanswered = (frontier ? deferredFacts(frontier) : []).filter(
        (fact) => !audit.claims.some((claim) => claim.text.includes(`(fact:${fact.id})`)),
      )
      if (unanswered.length)
        throw new FactoryError(
          `Research must answer every fact the grill deferred to it. Missing: ${unanswered
            .map((fact) => `${fact.id} — ${fact.question}`)
            .join(
              "; ",
            )}. Answer each on a tagged claim line in REPORT.md marked (fact:<id>), e.g. "- Postgres 16 is supported (fact:db) [VERIFIED: …]".`,
        )
      // The report's claims become the research dossier (witnessed again on
      // write). With a domain pack active, its constitution vets every claim
      // and gates the report by the pack's accept threshold; no pack leaves
      // the 1.0 behaviour unchanged.
      const claims = await claimsFromAudit(audit, cache)
      let packAudit: { readonly packId: string; readonly score: number } | undefined
      if (this.deps.domainPack !== undefined) {
        const pack = await loadDomainPack(this.deps.domainPack).catch((error: Error) => {
          throw new FactoryError(`The configured domain pack cannot be loaded: ${error.message}`)
        })
        const constitution = constitutionFromPack(pack)
        const retracted = new Set((await readRetractions(this.root)).map((entry) => entry.source))
        const knownIds = new Set(claims.map((claim) => claim.id))
        const rejected = claims
          .map((claim) => claimVerdict(claim, { constitution, knownIds, retractedHashes: retracted }))
          .filter((verdict) => verdict.verdict === "REJECTED")
        if (rejected.length)
          throw new FactoryError(
            `The ${pack.packId} domain pack rejects ${rejected.length} claim(s):\n${rejected
              .map((verdict) => `- ${verdict.claimId}: ${verdict.reasons.join("; ")}`)
              .join("\n")}`,
          )
        const scored = computeEpistemicScoreFromClaims(claims, constitution)
        if (scored.score < constitution.acceptThreshold)
          throw new FactoryError(
            `The ${pack.packId} domain pack scores this report ${scored.score.toFixed(3)}, below its threshold ${constitution.acceptThreshold}. ` +
              `Verified ${scored.breakdown.verifiedPassed}, rejected ${scored.breakdown.unverifiedRejected}, negative knowledge ${scored.breakdown.negativeKnowledgeCount}, inferred ${scored.breakdown.inferredCount}, hypotheses ${scored.breakdown.hypothesisCount}.`,
          )
        packAudit = { packId: pack.packId, score: scored.score }
      }
      const dossier = await writeDossier(
        this.layout.researchDossier,
        buildDossier({
          mode: "research",
          subject: frontier?.idea ?? "research",
          claims,
          now: this.now(),
        }),
        { cache, now: () => this.now() },
      ).catch((error: Error) => {
        throw new FactoryError(`The research dossier could not be written: ${error.message}`)
      })
      // Keep only cited evidence, so the tracked cache stays small: what the
      // report cites, and whatever any other dossier (scout, audits) cites.
      const store = await ClaimStore.load(this.root)
      const cited = new Set([
        ...audit.cited,
        ...store.all().flatMap((claim) => (claim.source ? [claim.source.sha256] : [])),
      ])
      const removed = await cache.prune(cited)
      state.stage = "SPEC"
      await this.audit(`agent:${agentId}`, "stage.spec", {
        reportHash: sha256(report),
        coverage: audit.coverage,
        prunedSources: removed.length,
        claims: dossier.claims.length,
        evidenceHash: dossier.evidenceHash,
        ...(packAudit ? { domainPack: packAudit.packId, epistemicScore: packAudit.score } : {}),
      })
      return state
    })
  }

  // ------------------------------------------------------------ spec → build

  async startBuild(agentId: string | undefined): Promise<FactoryState> {
    this.requireSeat(agentId, "factory")
    return this.mutate(`agent:${agentId}`, async (state) => {
      this.requireStage(state, "SPEC")
      this.requireAuditsClear(state)
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

  async tiebreak(
    agentId: string | undefined,
    verdict: "pass" | "fail",
    notes: string,
    options: { audit?: string } = {},
  ): Promise<FactoryState> {
    this.requireSeat(agentId, "manager")
    if (options.audit) return this.auditTiebreak(agentId!, options.audit, verdict, notes)
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

  private qaOutcome(phase: PhaseRuntime): "pass" | "fail" | undefined {
    const { functional, adversarial, tiebreak } = phase.qa
    if (!functional || !adversarial) return undefined
    return functional.verdict === adversarial.verdict ? functional.verdict : tiebreak?.verdict
  }

  private async settleQa(state: FactoryState, phase: PhaseRuntime) {
    const { functional, adversarial, tiebreak } = phase.qa
    const outcome = this.qaOutcome(phase)
    if (!outcome || !functional || !adversarial) return
    if (outcome === "pass") {
      // An opened phase audit must pass (or be dismissed by a human) before the phase merges.
      if (phase.audit && phase.audit.status !== "passed" && phase.audit.status !== "dismissed") {
        phase.history.push({
          at: this.now().toISOString(),
          event: "qa-passed",
          notes: `awaiting audit ${phase.audit.id}`,
        })
        return
      }
      await this.passPhase(state, phase)
    } else
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
    // The reworked head needs auditing again.
    if (phase.audit && phase.audit.status !== "dismissed") reopen(phase.audit)
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

  // ------------------------------------------------------------ code audits

  /**
   * Open (or re-open) a code audit of the active phase or a path in the
   * project. The factory seat or a human may open one at any stage. With no
   * run, a human who names a ceiling starts a GRILL run whose provisional
   * spend ceiling it is (a later frontier approval sets the real one).
   */
  async openAudit(
    actor: string,
    target: AuditTarget,
    options: { ceilingUSD?: number } = {},
  ): Promise<{ state: FactoryState; audit: Audit }> {
    const human = actor.startsWith("human:")
    if (!human) this.requireSeat(actor, "factory")
    if (options.ceilingUSD !== undefined && !(options.ceilingUSD > 0))
      throw new FactoryError("A spend ceiling must be a positive amount.")
    const label = human ? actor : `agent:${actor}`
    if (target.kind === "path") target = { kind: "path", path: await this.auditPath(target.path) }
    return this.mutate(
      label,
      async (state) => {
        if (human && options.ceilingUSD !== undefined && state.spendCeilingUSD === undefined)
          state.spendCeilingUSD = options.ceilingUSD
        if (state.spendCeilingUSD === undefined)
          throw new FactoryError(
            "An audit needs a spend ceiling: this run has none yet. Run `es audit <target> --max-usd N` (a human, at a terminal).",
          )
        const at = this.now().toISOString()
        const fresh = (): Audit => ({
          id: `audit-${String(allAudits(state).length + 1).padStart(2, "0")}`,
          target,
          round: 1,
          status: "open",
          openedAt: at,
          openedBy: label,
        })
        let audit: Audit
        if (target.kind === "phase") {
          const phase = this.active(state)
          if (phase.id !== target.phase)
            throw new FactoryError(
              `Only the active phase (${phase.id}) can be audited as a phase; audit a path instead.`,
            )
          phase.audit = phase.audit ? reopen(phase.audit, label, at) : fresh()
          audit = phase.audit
        } else {
          const existing = state.audits.find(
            (item) => item.target.kind === "path" && item.target.path === target.path && item.status !== "dismissed",
          )
          audit = existing ? reopen(existing, label, at) : fresh()
          if (!existing) state.audits.push(audit)
        }
        await this.audit(label, "audit.open", { id: audit.id, target, round: audit.round })
        return { state, audit: structuredClone(audit) }
      },
      { create: human && options.ceilingUSD !== undefined },
    )
  }

  /**
   * Human-only (es audit / es scout --max-usd): make sure a run with a spend
   * ceiling exists, starting a GRILL run with this provisional ceiling when
   * there is none. An existing ceiling is never changed here.
   */
  async provisionRun(human: string, ceilingUSD: number): Promise<FactoryState> {
    if (!(ceilingUSD > 0)) throw new FactoryError("A spend ceiling must be a positive amount.")
    return this.mutate(
      `human:${human}`,
      async (state) => {
        if (state.spendCeilingUSD === undefined) {
          state.spendCeilingUSD = ceilingUSD
          await this.audit(`human:${human}`, "factory.ceiling.provisional", { ceilingUSD })
        }
        return state
      },
      { create: true },
    )
  }

  /** A path to audit, POSIX and relative to the root: must exist inside the project, outside .factory and .git. */
  private async auditPath(target: string): Promise<string> {
    const relative = relativeInside(this.root, target)
    if (relative === undefined) throw new FactoryError(`${target} is outside the project.`)
    if (/^(\.factory|\.git)(\/|$)/.test(relative))
      throw new FactoryError(`${relative} is factory state, not code to audit.`)
    if (!(await exists(path.join(this.root, relative)))) throw new FactoryError(`${relative} does not exist.`)
    return relative
  }

  /** Absolute directory whose files an audit's findings must point into. */
  async auditTree(auditId: string): Promise<{ audit: Audit; root: string; scope: string }> {
    const state = await this.read()
    const found = state && findAudit(state, auditId)
    if (!found) throw new FactoryError(`No audit "${auditId}" in this run.`)
    if (found.audit.target.kind === "path")
      return { audit: found.audit, root: this.root, scope: found.audit.target.path }
    if (!found.phase?.worktree) throw new FactoryError(`Phase ${found.audit.target.phase} has no worktree to audit.`)
    return { audit: found.audit, root: path.join(this.root, found.phase.worktree), scope: "." }
  }

  /** An auditor seat records its verdict; findings were witnessed by the caller (codeaudit). */
  async auditVerdict(
    agentId: string | undefined,
    auditId: string,
    verdict: "pass" | "fail",
    notes: string,
  ): Promise<{ state: FactoryState; audit: Audit; round: number }> {
    this.requireSeat(agentId, "auditor-thesis", "auditor-antithesis")
    return this.mutate(`agent:${agentId}`, async (state) => {
      const { audit, phase } = verdictTarget(state, auditId)
      const entry: Verdict = { verdict, by: agentId!, at: this.now().toISOString(), notes }
      if (seatOf(agentId) === "auditor-thesis") audit.thesis = entry
      else audit.antithesis = entry
      const round = audit.round
      await this.audit(`agent:${agentId}`, "audit.verdict", { id: audit.id, round, verdict })
      // Settling may fail the phase, which re-opens its audit for the next round.
      await this.settleAudit(state, audit, phase)
      return { state, audit: structuredClone(audit), round }
    })
  }

  /** Would an auditor's verdict on this audit be accepted now? Throws the refusal when not (read-only). */
  async checkAuditVerdict(agentId: string | undefined, auditId: string): Promise<Audit> {
    this.requireSeat(agentId, "auditor-thesis", "auditor-antithesis")
    const state = await this.read()
    if (!state) throw new FactoryError("No factory run here yet.")
    if (state.stage === "HALTED") throw new FactoryHalted(`Factory halted: ${state.halt?.reason}`)
    return structuredClone(verdictTarget(state, auditId).audit)
  }

  private async auditTiebreak(agentId: string, auditId: string, verdict: "pass" | "fail", notes: string) {
    return this.mutate(`agent:${agentId}`, async (state) => {
      const found = findAudit(state, auditId)
      if (!found) throw new FactoryError(`No audit "${auditId}" in this run.`)
      const { audit, phase } = found
      if (
        audit.status !== "open" ||
        !audit.thesis ||
        !audit.antithesis ||
        audit.thesis.verdict === audit.antithesis.verdict
      )
        throw new FactoryError("An audit tiebreak is only possible when the two auditors disagree.")
      audit.tiebreak = { verdict, by: agentId, at: this.now().toISOString(), notes }
      await this.audit(`agent:${agentId}`, "audit.tiebreak", { id: audit.id, verdict })
      await this.settleAudit(state, audit, phase)
      return state
    })
  }

  private async settleAudit(state: FactoryState, audit: Audit, phase: PhaseRuntime | undefined) {
    const { thesis, antithesis, tiebreak } = audit
    if (!thesis || !antithesis) return
    const outcome = thesis.verdict === antithesis.verdict ? thesis.verdict : tiebreak?.verdict
    if (!outcome) return
    audit.status = outcome === "pass" ? "passed" : "failed"
    await this.audit("system", `audit.${audit.status}`, { id: audit.id, round: audit.round })
    if (!phase) return
    if (audit.status === "passed") {
      if (this.qaOutcome(phase) === "pass") await this.passPhase(state, phase)
    } else
      await this.failPhase(
        state,
        phase,
        `audit ${audit.id}: ${[thesis, antithesis, tiebreak]
          .filter((item) => item?.verdict === "fail")
          .map((item) => item!.notes)
          .join(" | ")}`,
      )
  }

  /** Human-only (es audit dismiss): stop an audit from blocking, with the reason on record. */
  async dismissAudit(human: string, auditId: string, reason: string): Promise<FactoryState> {
    if (!reason.trim()) throw new FactoryError("Dismissing an audit needs a reason.")
    return this.mutate(`human:${human}`, async (state) => {
      const found = findAudit(state, auditId)
      if (!found) throw new FactoryError(`No audit "${auditId}" in this run.`)
      const { audit, phase } = found
      if (audit.status === "passed" || audit.status === "dismissed")
        throw new FactoryError(`Audit ${audit.id} is already ${audit.status}.`)
      audit.status = "dismissed"
      audit.dismissed = { by: `human:${human}`, at: this.now().toISOString(), reason }
      await this.audit(`human:${human}`, "audit.dismiss", { id: audit.id, reason })
      if (phase && state.stage === "QA" && phase.status === "qa" && this.qaOutcome(phase) === "pass")
        await this.passPhase(state, phase)
      return state
    })
  }

  /** Decision 2: an open or failed audit outside a phase refuses the next stage transition. */
  private requireAuditsClear(state: FactoryState) {
    const blocking = state.audits.filter((audit) => audit.status === "open" || audit.status === "failed")
    if (blocking.length)
      throw new FactoryError(
        `Blocked by code audit(s): ${blocking
          .map((audit) => `${audit.id} on ${describeTarget(audit.target)} is ${audit.status}`)
          .join(
            "; ",
          )}. The auditors must pass it (re-open after fixes), the manager break a split, or a human run \`es audit dismiss <id> --reason …\`.`,
      )
  }

  // ------------------------------------------------------------ release

  async release(agentId: string | undefined): Promise<FactoryState> {
    this.requireSeat(agentId, "factory")
    const state = await this.mutate(`agent:${agentId}`, (current) => {
      this.requireStage(current, "RELEASE")
      this.requireAuditsClear(current)
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
    // No run, nothing to charge; taking the lock would create .factory/runtime/ in any project.
    if (!(await this.read())) return undefined
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

/** Every audit in the run: phase audits and path audits. */
export function allAudits(state: FactoryState): Audit[] {
  return [...state.phases.flatMap((phase) => (phase.audit ? [phase.audit] : [])), ...state.audits]
}

/** The audit a verdict would land on, refusing when it cannot take one now. */
function verdictTarget(state: FactoryState, auditId: string): { audit: Audit; phase?: PhaseRuntime } {
  const found = findAudit(state, auditId)
  if (!found) throw new FactoryError(`No audit "${auditId}" in this run.`)
  const { audit, phase } = found
  if (audit.status !== "open")
    throw new FactoryError(
      `Audit ${audit.id} is ${audit.status}; it must be re-opened (es_audit_open) for a new round.`,
    )
  if (phase && (state.stage !== "QA" || phase.id !== state.activePhase || phase.status !== "qa"))
    throw new FactoryError(
      `Phase ${phase.id} is ${phase.status}; phase audits take verdicts in QA, at its committed head.`,
    )
  return found
}

function findAudit(state: FactoryState, id: string): { audit: Audit; phase?: PhaseRuntime } | undefined {
  for (const phase of state.phases) if (phase.audit?.id === id) return { audit: phase.audit, phase }
  const audit = state.audits.find((item) => item.id === id)
  return audit ? { audit } : undefined
}

/** A new round: verdicts cleared, open again. */
function reopen(audit: Audit, by?: string, at?: string): Audit {
  audit.round += 1
  audit.status = "open"
  delete audit.thesis
  delete audit.antithesis
  delete audit.tiebreak
  if (by) audit.openedBy = by
  if (at) audit.openedAt = at
  return audit
}
