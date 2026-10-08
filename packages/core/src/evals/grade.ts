// Deterministic grader for the opt-in evals. A case names strings the model's
// text must (or must not) contain — case-insensitive, so checks describe intent
// without being brittle about casing — and tools it must complete (or must not
// even attempt). Error events always fail a case.
export interface EvalChecks {
  readonly contains?: readonly string[]
  readonly notContains?: readonly string[]
  /** Tools the agent must call and that must complete (by tool name). */
  readonly toolsUsed?: readonly string[]
  /** Tools the agent must not call, not even in a refused attempt. */
  readonly toolsNotUsed?: readonly string[]
}

export interface EvalGrade {
  readonly pass: boolean
  readonly failures: readonly string[]
}

export function gradeOutput(output: string, checks: EvalChecks = {}): EvalGrade {
  const lower = output.toLowerCase()
  const failures: string[] = []
  for (const needle of checks.contains ?? [])
    if (!lower.includes(needle.toLowerCase())) failures.push(`missing: ${needle}`)
  for (const needle of checks.notContains ?? [])
    if (lower.includes(needle.toLowerCase())) failures.push(`must not contain: ${needle}`)
  return { pass: failures.length === 0, failures }
}

export interface EvalTokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** What an `opencode run --format json` event stream said and did. */
export interface EvalTranscript {
  readonly text: string
  /** Every tool call, in order, whatever its outcome. */
  readonly tools: readonly string[]
  /** The calls that completed; a refused or failed call is not here. */
  readonly completed: readonly string[]
  readonly errors: readonly string[]
  readonly steps: number
  /** Spend reported by `step_finish` events (USD; 0 when the model has no price). */
  readonly costUSD: number
  readonly tokens: EvalTokens
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/**
 * Tools whose outputs are raw evidence, not the seat's own words. Quoting
 * that evidence verbatim is the skill under test (the research case), so
 * their outputs stay out of the graded text: a fetch alone must never
 * satisfy a `contains` check.
 */
const RAW_EVIDENCE_TOOLS: ReadonlySet<string> = new Set(["es_research_fetch", "es_research_search"])

export function readTranscript(events: readonly unknown[]): EvalTranscript {
  const text: string[] = []
  const tools: string[] = []
  const completed: string[] = []
  const errors: string[] = []
  let steps = 0
  let costUSD = 0
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const raw of events) {
    const event = raw as {
      type?: string
      part?: {
        text?: string
        tool?: string
        state?: { status?: string; output?: unknown }
        cost?: unknown
        tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }
      }
      error?: { message?: string }
    }
    if (event?.type === "step_start") steps++
    else if (event?.type === "text" && typeof event.part?.text === "string") text.push(event.part.text)
    else if (event?.type === "tool_use" && typeof event.part?.tool === "string") {
      tools.push(event.part.tool)
      if (event.part.state?.status === "completed") completed.push(event.part.tool)
      // A completed call's output is what the stream said: a gate verdict
      // quoted nowhere in the narration still counts (the programmer case).
      // Raw-evidence tools are excluded (above); errored calls report no work.
      if (event.part.state?.status === "completed" && typeof event.part.state?.output === "string")
        if (!RAW_EVIDENCE_TOOLS.has(event.part.tool)) text.push(event.part.state.output)
    } else if (event?.type === "step_finish") {
      costUSD += num(event.part?.cost)
      tokens.input += num(event.part?.tokens?.input)
      tokens.output += num(event.part?.tokens?.output)
      tokens.reasoning += num(event.part?.tokens?.reasoning)
      tokens.cacheRead += num(event.part?.tokens?.cache?.read)
      tokens.cacheWrite += num(event.part?.tokens?.cache?.write)
    } else if (event?.type === "error") errors.push(event.error?.message ?? "unknown error")
  }
  return { text: text.join("\n"), tools, completed, errors, steps, costUSD, tokens }
}

export function gradeTranscript(transcript: EvalTranscript, checks: EvalChecks = {}): EvalGrade {
  const failures = [...gradeOutput(transcript.text, checks).failures]
  for (const error of transcript.errors) failures.push(`error event: ${error}`)
  for (const tool of checks.toolsUsed ?? [])
    if (!transcript.completed.includes(tool))
      failures.push(`${transcript.tools.includes(tool) ? "called but did not complete" : "did not call"}: ${tool}`)
  // An attempt at a forbidden tool counts even when the host refused it.
  for (const tool of checks.toolsNotUsed ?? [])
    if (transcript.tools.includes(tool)) failures.push(`must not call: ${tool}`)
  return { pass: failures.length === 0, failures }
}
