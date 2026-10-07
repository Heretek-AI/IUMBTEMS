// Deterministic grader for the opt-in evals. A case names strings the model
// output must (or must not) contain; matching is case-insensitive so the checks
// describe intent without being brittle about casing.
export interface EvalChecks {
  readonly contains?: readonly string[]
  readonly notContains?: readonly string[]
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
