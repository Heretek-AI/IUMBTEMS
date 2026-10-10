// Import scanning for the package-boundary gate (scripts/deps.ts), split out
// so the type-only rule is testable without running the gate.

// One static import/export statement (`from "specifier"`), a dynamic
// `import("specifier")`, or a side-effect `import "specifier"`. The clause
// decides whether a static import is type-only.
const IMPORT_STMT = /(import|export)\s+([^;]*?)\s*from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g

export interface ImportRef {
  readonly specifier: string
  /** Erased at compile time, so it carries no runtime dependency. */
  readonly typeOnly: boolean
}

/**
 * Whether a static import/export clause is erased under the repo's
 * `verbatimModuleSyntax: true` (tsconfig.base.json). Only a top-level
 * `import type …` / `export type …` is: inline members
 * (`import { type A } from "x"`) compile to `import {} from "x"`, which still
 * loads the module. A default import named `type` (`import type from "x"`,
 * `import type, { A } from "x"`) is a value import, so `type` must be followed
 * by a binding, a brace or `*`.
 */
const isTypeOnlyClause = (clause: string): boolean => /^type\s+[{*\w$]/.test(clause.trim())

/** Every import or re-export specifier in a source file, with whether it is type-only. */
export function importsOf(text: string): ImportRef[] {
  const refs: ImportRef[] = []
  for (const match of text.matchAll(IMPORT_STMT)) {
    const specifier = match[3] ?? match[4] ?? match[5]!
    refs.push({ specifier, typeOnly: match[3] !== undefined && isTypeOnlyClause(match[2]!) })
  }
  return refs
}
