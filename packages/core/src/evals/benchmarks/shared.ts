// Shared catalog builders (#171): the case constructor and the throwing stub.
import type { BenchmarkCase } from "../benchmarks.ts"

export const C = (
  id: BenchmarkCase["id"],
  category: BenchmarkCase["category"],
  difficulty: BenchmarkCase["difficulty"],
  description: string,
  entry: string,
  files: BenchmarkCase["files"],
  oracle: BenchmarkCase["oracle"],
  reference: BenchmarkCase["reference"],
): BenchmarkCase => ({ id, category, difficulty, description, entry, files, oracle, reference })

export const stub = (fn: string): string => "export function " + fn + '(): never {\n  throw new Error("stub")\n}\n'
