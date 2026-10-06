import { getApproval } from "../approval/record.ts"
import { appendAuditEntry } from "../audit/chain.ts"
import { runGates } from "../gates/engine.ts"
import type { GateResult } from "../schema/gates.ts"
import type { Phase } from "../schema/phase.ts"
import { checkStopFile } from "../trust/stop.ts"
import { createPhaseWorktree, removePhaseWorktree } from "../worktree/git.ts"
import { type FactoryState, loadState, saveState } from "./journal.ts"

export interface QAEvaluation {
  readonly qa_a_passed: boolean
  readonly qa_b_passed: boolean
  readonly managerTiebreak?: "pass" | "fail"
  readonly touchedFiles?: readonly string[]
}

const MAX_PHASES = 20
const MAX_TOTAL_RETRIES = 5
const MAX_RUNTIME_MS = 8 * 60 * 60 * 1000 // 8 hours

export class FactoryStateMachine {
  constructor(
    private readonly rootDir: string,
    private state: FactoryState,
  ) {}

  static async init(rootDir: string, spendCeilingUSD: number): Promise<FactoryStateMachine> {
    if (spendCeilingUSD <= 0) {
      throw new Error("Mandatory spend ceiling must be a positive number of USD.")
    }

    const existing = await loadState(rootDir)
    if (existing) {
      return new FactoryStateMachine(rootDir, existing)
    }

    const state: FactoryState = {
      stage: "GRILL",
      phases: [],
      spendCeilingUSD,
      totalSpendUSD: 0,
      totalRetries: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await saveState(rootDir, state)
    await appendAuditEntry(rootDir, {
      actor: "system",
      action: "factory_init",
      payload: { spendCeilingUSD },
    })

    return new FactoryStateMachine(rootDir, state)
  }

  static async resume(rootDir: string): Promise<FactoryStateMachine> {
    const state = await loadState(rootDir)
    if (!state) {
      throw new Error("No active factory session found in .factory/state.json to resume.")
    }
    return new FactoryStateMachine(rootDir, state)
  }

  getState(): Readonly<FactoryState> {
    return this.state
  }

  recordSpend(amountUSD: number): void {
    this.state.totalSpendUSD += amountUSD
  }

  addPhase(phase: Phase): void {
    if (this.state.phases.length >= MAX_PHASES) {
      throw new Error(`Cannot add phase: maximum limit of ${MAX_PHASES} phases reached.`)
    }
    this.state.phases.push(phase)
    if (!this.state.activePhaseId) {
      this.state.activePhaseId = phase.id
    }
  }

  private async checkCaps(): Promise<boolean> {
    // 1. Check STOP file
    const stopCheck = await checkStopFile(this.rootDir)
    if (stopCheck.stopped) {
      this.state.stage = "HALTED"
      this.state.haltReason = stopCheck.reason
      await saveState(this.rootDir, this.state)
      return false
    }

    // 2. Check Spend ceiling
    if (this.state.totalSpendUSD > this.state.spendCeilingUSD) {
      this.state.stage = "HALTED"
      this.state.haltReason = `Spend ceiling exceeded: ${this.state.totalSpendUSD} USD > max ${this.state.spendCeilingUSD} USD.`
      await saveState(this.rootDir, this.state)
      return false
    }

    // 3. Check Total Retries
    if (this.state.totalRetries > MAX_TOTAL_RETRIES) {
      this.state.stage = "HALTED"
      this.state.haltReason = `Total retry budget exceeded: ${this.state.totalRetries} > max ${MAX_TOTAL_RETRIES}.`
      await saveState(this.rootDir, this.state)
      return false
    }

    // 4. Check Runtime Cap
    const elapsed = Date.now() - new Date(this.state.startedAt).getTime()
    if (elapsed > MAX_RUNTIME_MS) {
      this.state.stage = "HALTED"
      this.state.haltReason = "Maximum autonomous runtime of 8 hours exceeded."
      await saveState(this.rootDir, this.state)
      return false
    }

    return true
  }

  async advance(qaEval?: QAEvaluation): Promise<FactoryState> {
    if (!(await this.checkCaps())) {
      return this.state
    }

    const { stage, activePhaseId } = this.state
    const activePhase = this.state.phases.find((p) => p.id === activePhaseId)

    switch (stage) {
      case "GRILL": {
        // Transition requires settled frontier and human approval
        const approval = await getApproval(this.rootDir, "grill")
        if (!approval) {
          throw new Error(
            "Cannot transition from GRILL to SPEC: requires settled frontier and human approval in .factory/approvals/grill.json.",
          )
        }
        this.state.stage = "SPEC"
        break
      }

      case "SPEC": {
        if (!activePhase) {
          throw new Error("Cannot transition from SPEC: no active phase configured.")
        }
        // Requires approval for the phase spec
        const approval = await getApproval(this.rootDir, "spec", activePhase.id)
        if (!approval) {
          throw new Error(
            `Cannot transition phase ${activePhase.id} from SPEC to BUILD: requires approved GOAL.md in .factory/approvals/spec-${activePhase.id}.json.`,
          )
        }

        // Setup worktree for programmer
        const worktree = await createPhaseWorktree(this.rootDir, activePhase.id)
        activePhase.worktreePath = worktree.worktreePath
        activePhase.branch = worktree.branch
        activePhase.state = "RUNNING"
        this.state.stage = "BUILD"
        break
      }

      case "BUILD": {
        if (!activePhase) throw new Error("No active phase in BUILD stage.")
        activePhase.state = "QA"
        this.state.stage = "QA"
        break
      }

      case "QA": {
        if (!activePhase) throw new Error("No active phase in QA stage.")
        if (!qaEval) {
          throw new Error("Advancing from QA requires a QAEvaluation input.")
        }

        // 1. Run deterministic mechanical gates
        const gateResult: GateResult = await runGates(this.rootDir, {
          touchedFiles: qaEval.touchedFiles,
          phaseId: activePhase.id,
        })

        // 2. Dual QA evaluation
        let qaPassed = false
        if (qaEval.qa_a_passed && qaEval.qa_b_passed) {
          qaPassed = true
        } else if (qaEval.qa_a_passed !== qaEval.qa_b_passed) {
          // Divergence: manager tiebreak required
          qaPassed = qaEval.managerTiebreak === "pass"
        }

        const overallPass = gateResult.passed && qaPassed

        if (overallPass) {
          // Success: clean up worktree, approve phase
          if (activePhase.worktreePath) {
            await removePhaseWorktree(this.rootDir, activePhase.id)
          }
          activePhase.state = "APPROVED"

          // Check if more phases remain
          const nextPhase = this.state.phases.find((p) => p.state === "PENDING")
          if (nextPhase) {
            this.state.activePhaseId = nextPhase.id
            this.state.stage = "SPEC"
          } else {
            this.state.stage = "RELEASE"
          }
        } else {
          // Failure handling: 3 retries, 1 replan, 2 attempts, halt
          activePhase.attempts++
          this.state.totalRetries++

          if (activePhase.attempts < 3) {
            // Retry build
            this.state.stage = "BUILD"
          } else if (activePhase.attempts === 3 && activePhase.replanCount === 0) {
            // Replan once: reset attempts, increment replan, go back to SPEC
            activePhase.replanCount = 1
            activePhase.attempts = 0
            this.state.stage = "SPEC"
          } else {
            // Exceeded retries: halt
            activePhase.state = "FAILED"
            this.state.stage = "HALTED"
            this.state.haltReason = `Phase ${activePhase.id} exceeded retry budget (3 attempts + 1 replan + 2 attempts reached).`
          }
        }
        break
      }

      case "RELEASE": {
        const approval = await getApproval(this.rootDir, "release")
        if (!approval) {
          throw new Error(
            "Cannot transition from RELEASE to DONE: requires human release approval in .factory/approvals/release.json.",
          )
        }
        this.state.stage = "DONE"
        break
      }

      case "DONE":
      case "HALTED":
        // Terminal states
        break
    }

    await saveState(this.rootDir, this.state)
    await appendAuditEntry(this.rootDir, {
      actor: "manager",
      action: "factory_advance",
      payload: { stage: this.state.stage, activePhaseId: this.state.activePhaseId },
    })

    return this.state
  }
}
