// Fleet daemon loop (#125, clean-room): one `tick` folds the scheduler
// decision into worktree allocation, worker launches, event reports and
// gated landings. All DAG mutations serialize through a promise mutex; every
// collaborator the loop cannot own in tests (spawning, gates) is injected.

import { applyDecision, reportTask, schedule, type TaskReport } from "./scheduler.ts"
import { loadDag, saveDag } from "./tasks.ts"
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
      const { reattached, failed } = this.supervisor.recover(records, Date.now())
      const now = new Date().toISOString()
      let dag = (await loadDag(this.options.stateRoot)) ?? { v: 1 as const, tasks: {} }
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
      const now = new Date().toISOString()
      let dag = (await loadDag(this.options.stateRoot)) ?? { v: 1 as const, tasks: {} }
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
        const probe = this.breaker.probe(id, Date.now())
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
          this.supervisor.track(id, snapshot.pid ?? -1, {
            spendUsd: snapshot.spendUsd,
            tokensIn: snapshot.tokensIn,
            tokensOut: snapshot.tokensOut,
          })
          this.ports.set(id, port)
          await saveWorkerPids(
            this.options.stateRoot,
            Object.fromEntries(this.supervisor.entries().map((entry) => [entry.taskId, entry.pid])),
          )
          void port
            .run()
            .then(async (outcome) => {
              this.supervisor.untrack(id)
              this.ports.delete(id)
              await saveWorkerPids(
                this.options.stateRoot,
                Object.fromEntries(this.supervisor.entries().map((entry) => [entry.taskId, entry.pid])),
              ).catch(() => undefined)
              if (outcome.status === "failed") this.breaker.noteCrash(id, Date.now())
            })
            .catch((error) => {
              const reason = `worker crashed: ${error instanceof Error ? error.message : String(error)}`
              this.supervisor.untrack(id)
              this.ports.delete(id)
              this.breaker.noteCrash(id, Date.now())
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
    })
  }

  /** Fold one worker report into the DAG (called from worker callbacks). */
  async foldReport(taskId: string, report: TaskReport): Promise<void> {
    await this.exclusive(async () => {
      const now = new Date().toISOString()
      const dag = (await loadDag(this.options.stateRoot)) ?? { v: 1 as const, tasks: {} }
      // Late reports after teardown name unknown tasks: not an error, drop them.
      if (!dag.tasks[taskId]) {
        this.emit({ type: "refused", taskId, detail: "stale report for an unknown task" })
        return
      }
      const next = reportTask(dag, taskId, report, now)
      if (next.changed) {
        await saveDag(this.options.stateRoot, next.dag)
        this.emit({ type: "report", taskId, detail: report.outcome })
      }
    })
  }

  private async reconcileTerminals(): Promise<void> {
    const now = new Date().toISOString()
    let dag = (await loadDag(this.options.stateRoot)) ?? { v: 1 as const, tasks: {} }
    for (const id of Object.keys(dag.tasks).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
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
          "fleet",
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
      const now = new Date().toISOString()
      let dag = (await loadDag(this.options.stateRoot)) ?? { v: 1 as const, tasks: {} }
      for (const id of Object.keys(dag.tasks).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (dag.tasks[id]!.status !== "running") continue
        const next = reportTask(dag, id, { outcome: "cancelled", reason: "fleet stopped; run is resumable" }, now)
        dag = next.dag
      }
      await saveDag(this.options.stateRoot, dag)
    })
  }
}
