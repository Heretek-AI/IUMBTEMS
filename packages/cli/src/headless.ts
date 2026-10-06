import { FactoryStateMachine, runGates } from "@heretek-ai/es-core"

export interface HeadlessEvent {
  readonly timestamp: string
  readonly type: "status" | "gates" | "step" | "halt" | "done"
  readonly data: Record<string, unknown>
}

export async function* runHeadless(rootDir: string): AsyncGenerator<HeadlessEvent> {
  const machine = await FactoryStateMachine.resume(rootDir)
  let state = machine.getState()

  yield {
    timestamp: new Date().toISOString(),
    type: "status",
    data: { state },
  }

  while (state.stage !== "DONE" && state.stage !== "HALTED") {
    yield {
      timestamp: new Date().toISOString(),
      type: "step",
      data: { stage: state.stage, activePhaseId: state.activePhaseId },
    }

    try {
      if (state.stage === "QA") {
        const gates = await runGates(rootDir)
        yield {
          timestamp: new Date().toISOString(),
          type: "gates",
          data: { gates },
        }
        // In headless mode, evaluate with gates result
        state = await machine.advance({
          qa_a_passed: gates.passed,
          qa_b_passed: gates.passed,
        })
      } else {
        state = await machine.advance()
      }
    } catch (err: any) {
      yield {
        timestamp: new Date().toISOString(),
        type: "halt",
        data: { error: err.message },
      }
      break
    }

    yield {
      timestamp: new Date().toISOString(),
      type: "status",
      data: { state },
    }
  }

  if (state.stage === "DONE") {
    yield {
      timestamp: new Date().toISOString(),
      type: "done",
      data: { state },
    }
  }
}
