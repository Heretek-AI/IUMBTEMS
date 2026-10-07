// Deterministic grader for the opt-in evals. A case names strings the model's
// text must (or must not) contain — case-insensitive, so checks describe intent
// without being brittle about casing — and tools it must (or must not) call.
// Error events always fail a case.
export interface EvalChecks {
  readonly contains?: readonly string[]
  readonly notContains?: readonly string[]
  /** Tools the agent must call (by tool name). */
  readonly toolsUsed?: readonly string[]
  /** Tools the agent must not call. */
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

/** What an `opencode run --format json` event stream said and did. */
export interface EvalTranscript {
  readonly text: string
  readonly tools: readonly string[]
  readonly errors: readonly string[]
  readonly steps: number
}

export function readTranscript(events: readonly unknown[]): EvalTranscript {
  const text: string[] = []
  const tools: string[] = []
  const errors: string[] = []
  let steps = 0
  for (const raw of events) {
    const event = raw as { type?: string; part?: { text?: string; tool?: string }; error?: { message?: string } }
    if (event?.type === "step_start") steps++
    else if (event?.type === "text" && typeof event.part?.text === "string") text.push(event.part.text)
    else if (event?.type === "tool_use" && typeof event.part?.tool === "string") tools.push(event.part.tool)
    else if (event?.type === "error") errors.push(event.error?.message ?? "unknown error")
  }
  return { text: text.join("\n"), tools, errors, steps }
}

export function gradeTranscript(transcript: EvalTranscript, checks: EvalChecks = {}): EvalGrade {
  const failures = [...gradeOutput(transcript.text, checks).failures]
  for (const error of transcript.errors) failures.push(`error event: ${error}`)
  for (const tool of checks.toolsUsed ?? [])
    if (!transcript.tools.includes(tool)) failures.push(`did not call: ${tool}`)
  for (const tool of checks.toolsNotUsed ?? [])
    if (transcript.tools.includes(tool)) failures.push(`must not call: ${tool}`)
  return { pass: failures.length === 0, failures }
}
