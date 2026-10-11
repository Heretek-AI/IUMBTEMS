// Fleet daemon loop (#125, clean-room): one `tick` folds the scheduler
// decision into worktree allocation, worker launches, event reports and
// gated landings. All DAG mutations serialize through a promise mutex; every
// collaborator the loop cannot own in tests (spawning, gates) is injected.

import { HEARTBEAT_VERSION, recordFleetHeartbeat } from "./heartbeat.ts"
import { applyDecision, markGateFailed, reportTask, schedule, type TaskReport } from "./scheduler.ts"
import { emptyDag, loadDag, saveDag } from "./tasks.ts"
import {
  CircuitBreaker,
  loadWorkerPids,
  prepareTaskRun,
  type SpendAcc,
  saveWorkerPids,
  Worker,
  type WorkerOutcome,
  type WorkerSpec,
  WorkerSupervisor,
} from "./worker.ts"
import { allocateWorktree, type GateCheck, landTask, loadRegistry, releaseWorktree } from "./worktree.ts"

export interface WorkerPort {
  run(): Promise<WorkerOutcome>
  stop(): Promise<void>
  snapshot(): SpendAcc & { taskId: string; pid: number | undefined }
}

export interface TransitionEvent {
  readonly type: "started" | "report" | "landed" | "released" | "refused" | "recovered"
  readonly taskId: string
  readonly detail?: string
}

export interface DaemonOptions {
  readonly repoRoot: string
  readonly stateRoot: string
  readonly esBin: string
  readonly concurrency?: number
  readonly fleetCeilingUsd: number
  readonly checkGates: GateCheck
  readonly spawnWorker?: (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void) => WorkerPort
  readonly onTransition?: (event: TransitionEvent) => void
  /** Integration-branch namespace for landings (default "fleet"). */
  readonly dagId?: string
  /** Clock override (tests, determinism). */
  readonly now?: () => number
  /**
   * A tracked turn with no folded report for longer than this is stopped and
   * failed for restart (the task's own failure policy decides: retry
   * re-queues, otherwise terminal). Undefined disables the check: real
   * workers only report terminal events, so a short default would kill
   * legitimate long turns. The `run-dag` verb defaults this to 30 minutes.
   */
  readonly stuckTimeoutMs?: number
}

/**
 * The daemon: human-started (see lifecycle.ts), it owns worker processes and
 * folds their reports back into the DAG. `tick` is idempotent: safe to call
 * on a timer and after every worker report.
 */
export class FleetDaemon {
  private readonly supervisor = new WorkerSupervisor()
  private readonly breaker = new CircuitBreaker({
    maxRestarts: 3,
    windowMs: 300_000,
    cooldownMs: 300_000,
    massThreshold: 5,
  })
  private readonly ports = new Map<string, WorkerPort>()
  /** Tasks whose landing conflicted: retried after human repair, else waiting. */
  private readonly conflicted = new Set<string>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: DaemonOptions) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private emit(event: TransitionEvent): void {
    this.options.onTransition?.(event)
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now()
  }

  private stamp(): string {
    return new Date(this.clock()).toISOString()
  }

  private dagId(): string {
    return this.options.dagId ?? "fleet"
  }

  /** Best-effort progress heartbeat for humans and factory seats (never throws). */
  private async heartbeat(): Promise<void> {
    try {
      const dag = (await loadDag(this.options.stateRoot)) ?? emptyDag()
      const tasks: Record<string, { status: string; attempts: number; updatedAt: string }> = {}
      for (const [id, task] of Object.entries(dag.tasks))
        tasks[id] = { status: task.status, attempts: task.attempts, updatedAt: task.updatedAt }
      await recordFleetHeartbeat(this.options.repoRoot, {
        v: HEARTBEAT_VERSION,
        at: this.stamp(),
        pid: process.pid,
        dagId: this.dagId(),
        tasks,
      })
    } catch {
      // Heartbeats are advisory: a read-only checkout must not fail the run.
    }
  }

  private caps() {
    return { concurrency: this.options.concurrency ?? 4, fleetCeilingUsd: this.options.fleetCeilingUsd }
  }

  private spawner(spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void): WorkerPort {
    if (this.options.spawnWorker) return this.options.spawnWorker(spec, onReport)
    return new Worker({ ...spec, esBin: this.options.esBin, onReport })
  }

  /** Reconcile worker tracking after a daemon restart (see WorkerSupervisor). */
  async recover(workers?: ReadonlyArray<{ taskId: string; pid: number }>): Promise<void> {
    let records: ReadonlyArray<{ taskId: string; pid: number }> = workers ?? []
    if (workers === undefined) {
      const pids = await loadWorkerPids(this.options.stateRoot)
      records = Object.entries(pids).map(([taskId, pid]) => ({ taskId, pid }))
    }
    await this.exclusive(async () => {
      const { reattached, failed } = this.supervisor.recover(records, this.clock())
      const now = this.stamp()
      let dag = (await loadDag(this.options.stateRoot)) ?? emptyDag()
      for (const taskId of reattached) this.emit({ type: "recovered", taskId, detail: "reattached to live run" })
      for (const { taskId, reason } of failed) {
        const next = reportTask(dag, taskId, { outcome: "failed", reason }, now)
        dag = next.dag
        if (next.changed) this.emit({ type: "recovered", taskId, detail: "marked failed: daemon restarted" })
      }
      await saveDag(this.options.stateRoot, dag)
    })
  }

  /** One reconcile pass: schedule, allocate, launch, land, release. */
  async tick(): Promise<void> {
    await this.exclusive(async () => {
      const now = this.stamp()
      let dag = (await loadDag(this.options.stateRoot)) ?? emptyDag()
      const decision = schedule(dag, this.caps())
      dag = applyDecision(dag, { unblock: decision.unblock, start: [], cancel: decision.cancel }, now)
      const launched: string[] = []
      for (const id of decision.start) {
        const task = dag.tasks[id]
        if (!task || task.status === "running") continue
        try {
          this.supervisor.requireStartable(id)
        } catch {
          continue
        }
        const probe = this.breaker.probe(id, this.clock())
        if (probe !== "ok") {
          this.emit({ type: "refused", taskId: id, detail: probe.refused })
          continue
        }
        const spec: WorkerSpec = {
          taskId: id,
          worktreeDir: "",
          ceilingUSD: task.ceilingUSD,
          kind: task.kind,
          objective: task.input.objective,
          esBin: this.options.esBin,
        }
        try {
          const record = await allocateWorktree(this.options.repoRoot, this.options.stateRoot, id, { now }).catch(
            async () => (await loadRegistry(this.options.stateRoot))?.worktrees[id],
          )
          if (record?.status !== "allocated") continue
          await prepareTaskRun({ ...spec, worktreeDir: record.dir })
          const port = this.spawner(
            { ...spec, worktreeDir: record.dir },
            (taskId, report) => void this.foldReport(taskId, report),
          )
          const snapshot = port.snapshot()
          this.supervisor.track(
            id,
            snapshot.pid ?? -1,
            {
              spendUsd: snapshot.spendUsd,
              tokensIn: snapshot.tokensIn,
              tokensOut: snapshot.tokensOut,
            },
            this.clock(),
          )
          this.ports.set(id, port)
          await saveWorkerPids(
            this.options.stateRoot,
            Object.fromEntries(this.supervisor.entries().map((entry) => [entry.taskId, entry.pid])),
          )
          void port
            .run()
            .then(async (outcome) => {
              // A restarted turn's late settlement must not untrack the
              // relaunch: only the currently-owned port may clear tracking.
              if (this.ports.get(id) !== port) return
              this.supervisor.untrack(id)
              this.ports.delete(id)
              await saveWorkerPids(
                this.options.stateRoot,
                Object.fromEntries(this.supervisor.entries().map((entry) => [entry.taskId, entry.pid])),
              ).catch(() => undefined)
              if (outcome.status === "failed") this.breaker.noteCrash(id, this.clock())
            })
            .catch((error) => {
              // Likewise: a restarted turn's late crash must not fold a second
              // failure over the re-queued task nor untrack its relaunch.
              if (this.ports.get(id) !== port) return
              const reason = `worker crashed: ${error instanceof Error ? error.message : String(error)}`
              this.supervisor.untrack(id)
              this.ports.delete(id)
              this.breaker.noteCrash(id, this.clock())
              this.emit({ type: "refused", taskId: id, detail: reason })
              void this.foldReport(id, { outcome: "failed", reason })
            })
          launched.push(id)
          this.emit({ type: "started", taskId: id, detail: record.dir })
        } catch (error) {
          this.emit({ type: "refused", taskId: id, detail: error instanceof Error ? error.message : String(error) })
        }
      }
      dag = applyDecision(dag, { unblock: [], start: launched, cancel: [] }, now)
      await saveDag(this.options.stateRoot, dag)
      await this.reconcileTerminals()
      await this.restartStuck()
      await this.heartbeat()
    })
  }

  /** Fold one worker report into the DAG (called from worker callbacks). */
  async foldReport(taskId: string, report: TaskReport): Promise<void> {
    await this.exclusive(async () => {
      const now = this.stamp()
      const dag = (await loadDag(this.options.stateRoot)) ?? emptyDag()
      // Late reports after teardown name unknown tasks: not an error, drop them.
      if (!dag.tasks[taskId]) {
        this.emit({ type: "refused", taskId, detail: "stale report for an unknown task" })
        return
      }
      this.supervisor.noteActivity(taskId, this.clock())
      const next = reportTask(dag, taskId, report, now)
      if (next.changed) {
        await saveDag(this.options.stateRoot, next.dag)
        this.emit({ type: "report", taskId, detail: report.outcome })
      }
      await this.heartbeat()
    })
  }

  /**
   * Stop turns with no worker progress past the stuck timeout and fail them
   * for restart: the task's own failure policy decides (retry re-queues while
   * attempts remain, otherwise terminal). Skipped when no stuck timeout is
   * configured. Only `running` tasks are eligible; a turn launched earlier
   * in this same tick is never stuck (its activity stamp is current).
   */
  private async restartStuck(): Promise<void> {
    const timeoutMs = this.options.stuckTimeoutMs
    if (timeoutMs === undefined) return
    const now = this.stamp()
    let dag = (await loadDag(this.options.stateRoot)) ?? emptyDag()
    let saved = false
    for (const id of this.supervisor.stuckTasks(this.clock(), timeoutMs)) {
      if (dag.tasks[id]?.status !== "running") continue
      const port = this.ports.get(id)
      await port?.stop().catch(() => undefined)
      this.ports.delete(id)
      this.supervisor.untrack(id)
      this.breaker.noteCrash(id, this.clock())
      const next = reportTask(
        dag,
        id,
        { outcome: "failed", reason: `stuck turn: no worker progress for ${timeoutMs}ms; restarting` },
        now,
      )
      dag = next.dag
      saved = next.changed || saved
      this.emit({ type: "report", taskId: id, detail: "failed: stuck turn restarted" })
    }
    if (saved) await saveDag(this.options.stateRoot, dag)
  }

  private async reconcileTerminals(): Promise<void> {
    const now = this.stamp()
    let dag = (await loadDag(this.options.stateRoot)) ?? emptyDag()
    for (const id of Object.keys(dag.tasks).sort((a, b) => a.localeCompare(b))) {
      const task = dag.tasks[id]!
      const conflicted = task.status === "waiting-human" && this.conflicted.has(id)
      if (task.status !== "done" && task.status !== "failed" && task.status !== "cancelled" && !conflicted) continue
      const record = (await loadRegistry(this.options.stateRoot))?.worktrees[id]
      if (record?.status !== "allocated") {
        this.conflicted.delete(id)
        continue
      }
      if (task.status === "done" || conflicted) {
        const landed = await landTask(
          this.options.repoRoot,
          this.options.stateRoot,
          id,
          this.dagId(),
          this.options.checkGates,
        )
        if (landed.landed) {
          this.conflicted.delete(id)
          if (conflicted) {
            const next = reportTask(dag, id, { outcome: "done", reason: "landed after human repair" }, now)
            dag = next.dag
            await saveDag(this.options.stateRoot, dag)
          }
          await releaseWorktree(this.options.repoRoot, this.options.stateRoot, id, "merged")
          this.emit({ type: "released", taskId: id, detail: "landed and released" })
        } else if (landed.conflict) {
          this.conflicted.add(id)
          const next = reportTask(dag, id, { outcome: "waiting-human", reason: landed.reason }, now)
          dag = next.dag
          await saveDag(this.options.stateRoot, dag)
          this.emit({ type: "report", taskId: id, detail: "waiting-human: merge conflict" })
        } else if (landed.gateFailed) {
          // Gates rejected the work: the task failed, nothing was merged.
          const next = markGateFailed(dag, id, landed.reason, now)
          dag = next.dag
          await saveDag(this.options.stateRoot, dag)
          await releaseWorktree(this.options.repoRoot, this.options.stateRoot, id, "abandoned")
          this.emit({ type: "report", taskId: id, detail: "failed: gates rejected the landing" })
        }
      } else {
        await releaseWorktree(this.options.repoRoot, this.options.stateRoot, id, "abandoned")
        this.emit({ type: "released", taskId: id, detail: `released (${task.status})` })
      }
    }
  }

  /**
   * Kill switch (`es-fleet stop`): SIGTERM every worker, wait, and record
   * the cancellations so the runs stay resumable.
   */
  async shutdown(): Promise<void> {
    for (const [taskId, port] of [...this.ports]) {
      await port.stop().catch(() => undefined)
      this.ports.delete(taskId)
      this.supervisor.untrack(taskId)
    }
    await this.exclusive(async () => {
      const now = this.stamp()
      let dag = (await loadDag(this.options.stateRoot)) ?? emptyDag()
      for (const id of Object.keys(dag.tasks).sort((a, b) => a.localeCompare(b))) {
        if (dag.tasks[id]!.status !== "running") continue
        const next = reportTask(dag, id, { outcome: "cancelled", reason: "fleet stopped; run is resumable" }, now)
        dag = next.dag
      }
      await saveDag(this.options.stateRoot, dag)
    })
  }
}
