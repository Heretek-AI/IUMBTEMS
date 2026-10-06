// Tool output → structured findings (file:line:rule + message). Paths are made
// relative to the run directory. Parsers never throw: unparseable output falls
// back to the generic file:line scanner, and a failing command with no
// findings still yields one finding pointing at its log.
import path from "node:path"
import type { GateFinding, ParserId } from "../schema/gates.ts"

export interface ParsedOutput {
  readonly findings: GateFinding[]
  /** Test files with failures (test parsers only). */
  readonly failedTests: string[]
}

type Parser = (output: string, dir: string, check: string) => ParsedOutput

const relative = (dir: string, file: string) => {
  const cleaned = file.replace(/^file:\/\//, "")
  const rel = path.isAbsolute(cleaned) ? path.relative(dir, cleaned) : cleaned
  return rel.split(path.sep).join("/").replace(/^\.\//, "")
}

const none = (): ParsedOutput => ({ findings: [], failedTests: [] })

function jsonBlocks(output: string): unknown[] {
  const out: unknown[] = []
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // not a JSON line
    }
  }
  if (out.length === 0) {
    const start = output.search(/[[{]/)
    if (start >= 0)
      try {
        out.push(JSON.parse(output.slice(start)))
      } catch {
        // not JSON
      }
  }
  return out
}

const tsc: Parser = (output, dir, check) => {
  const findings: GateFinding[] = []
  for (const match of output.matchAll(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/gm))
    findings.push({
      file: relative(dir, match[1]!),
      line: Number(match[2]),
      column: Number(match[3]),
      rule: `typecheck/${match[5]}`,
      severity: match[4] === "warning" ? "warning" : "error",
      message: match[6]!,
      check,
    })
  for (const match of output.matchAll(/^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/gm))
    findings.push({
      file: relative(dir, match[1]!),
      line: Number(match[2]),
      column: Number(match[3]),
      rule: `typecheck/${match[5]}`,
      severity: match[4] === "warning" ? "warning" : "error",
      message: match[6]!,
      check,
    })
  return { findings, failedTests: [] }
}

const biome: Parser = (output, dir, check) => {
  const findings: GateFinding[] = []
  for (const block of jsonBlocks(output) as Array<{ diagnostics?: any[] }>) {
    for (const diagnostic of block?.diagnostics ?? []) {
      if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") continue
      const category: string = diagnostic.category ?? "biome"
      const isFormat = category === "format"
      findings.push({
        file: relative(dir, diagnostic.location?.path ?? "."),
        ...(diagnostic.location?.start?.line ? { line: diagnostic.location.start.line } : {}),
        ...(diagnostic.location?.start?.column ? { column: diagnostic.location.start.column } : {}),
        rule: isFormat ? "format/biome" : category,
        severity: diagnostic.severity,
        message: isFormat ? "File is not formatted" : diagnostic.message,
        ...(isFormat
          ? { fixHint: "Run `biome format --write` on this file." }
          : diagnostic.advices?.[0]?.text
            ? { fixHint: diagnostic.advices[0].text }
            : {}),
        check,
      })
    }
  }
  return { findings, failedTests: [] }
}

const eslint: Parser = (output, dir, check) => {
  const findings: GateFinding[] = []
  for (const block of jsonBlocks(output)) {
    if (!Array.isArray(block)) continue
    for (const file of block)
      for (const message of file.messages ?? [])
        findings.push({
          file: relative(dir, file.filePath),
          line: message.line,
          column: message.column,
          rule: `eslint/${message.ruleId ?? "parse"}`,
          severity: message.severity === 2 ? "error" : "warning",
          message: message.message,
          check,
        })
  }
  return { findings, failedTests: [] }
}

const prettier: Parser = (output, dir, check) => ({
  findings: [...output.matchAll(/^\[warn\] (?!Code style issues)(.+)$/gm)].map((match) => ({
    file: relative(dir, match[1]!.trim()),
    rule: "format/prettier",
    severity: "error" as const,
    message: "File is not formatted",
    fixHint: "Run `prettier --write` on this file.",
    check,
  })),
  failedTests: [],
})

const ruff: Parser = (output, dir, check) => {
  const findings: GateFinding[] = []
  for (const block of jsonBlocks(output)) {
    if (!Array.isArray(block)) continue
    for (const item of block)
      findings.push({
        file: relative(dir, item.filename),
        line: item.location?.row,
        column: item.location?.column,
        rule: `ruff/${item.code ?? "syntax"}`,
        severity: "error",
        message: item.message,
        ...(item.fix?.message ? { fixHint: item.fix.message } : {}),
        check,
      })
  }
  return { findings, failedTests: [] }
}

const ruffFormat: Parser = (output, dir, check) => ({
  findings: [...output.matchAll(/^Would reformat: (.+)$/gm)].map((match) => ({
    file: relative(dir, match[1]!.trim()),
    rule: "format/ruff",
    severity: "error" as const,
    message: "File is not formatted",
    fixHint: "Run `ruff format` on this file.",
    check,
  })),
  failedTests: [],
})

const mypy: Parser = (output, dir, check) => ({
  findings: [...output.matchAll(/^(.+?):(\d+):(?:(\d+):)? (error|warning): (.+?)(?:\s+\[([\w-]+)\])?$/gm)].map(
    (match) => ({
      file: relative(dir, match[1]!),
      line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}),
      rule: `mypy/${match[6] ?? "error"}`,
      severity: match[4] === "warning" ? ("warning" as const) : ("error" as const),
      message: match[5]!,
      check,
    }),
  ),
  failedTests: [],
})

const cargo: Parser = (output, dir, check) => {
  const findings: GateFinding[] = []
  for (const block of jsonBlocks(output) as any[]) {
    if (block?.reason !== "compiler-message") continue
    const message = block.message
    if (message?.level !== "error" && message?.level !== "warning") continue
    const span = (message.spans ?? []).find((item: any) => item.is_primary) ?? message.spans?.[0]
    findings.push({
      file: span ? relative(dir, span.file_name) : ".",
      ...(span ? { line: span.line_start, column: span.column_start } : {}),
      rule: `rust/${message.code?.code ?? "compile"}`,
      severity: message.level === "error" ? "error" : "warning",
      message: message.message,
      check,
    })
  }
  return { findings, failedTests: [] }
}

const gofmt: Parser = (output, dir, check) => ({
  findings: output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".go"))
    .map((file) => ({
      file: relative(dir, file),
      rule: "format/gofmt",
      severity: "error" as const,
      message: "File is not gofmt-formatted",
      fixHint: "Run `gofmt -w` on this file.",
      check,
    })),
  failedTests: [],
})

const goVet: Parser = (output, dir, check) => ({
  findings: [...output.matchAll(/^(?:vet: )?(\S+\.go):(\d+):(\d+): (.+)$/gm)].map((match) => ({
    file: relative(dir, match[1]!),
    line: Number(match[2]),
    column: Number(match[3]),
    rule: "go/vet",
    severity: "error" as const,
    message: match[4]!,
    check,
  })),
  failedTests: [],
})

const bunTest: Parser = (output, dir, check) => {
  const findings: GateFinding[] = []
  const failed = new Set<string>()
  let current: string | undefined
  let location: { file: string; line: number } | undefined
  let unhandled = false
  for (const line of output.split("\n")) {
    if (/^# Unhandled error/.test(line.trim())) {
      unhandled = true
      continue
    }
    if (unhandled && /^error: /.test(line.trim())) {
      unhandled = false
      const file = current ?? "."
      failed.add(file)
      findings.push({
        file,
        rule: "test/failed",
        severity: "error",
        message: `Test file errored: ${line.trim().slice(7, 300)}`,
        check,
      })
      continue
    }
    const header = /^(\S+\.(?:test|spec|_test_|_spec_)\.[cm]?[jt]sx?|\S*(?:test|spec)\S*\.[cm]?[jt]sx?):$/.exec(
      line.trim(),
    )
    if (header) {
      current = relative(dir, header[1]!)
      location = undefined
      continue
    }
    const at = /\((\/[^)]+?):(\d+):\d+\)\s*$/.exec(line) ?? /at (\/\S+?):(\d+):\d+\s*$/.exec(line)
    if (at && !at[1]!.includes("node_modules")) location = { file: relative(dir, at[1]!), line: Number(at[2]) }
    const fail = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line.trim())
    if (fail) {
      const file = location?.file ?? current ?? "."
      failed.add(current ?? file)
      findings.push({
        file,
        ...(location ? { line: location.line } : {}),
        rule: "test/failed",
        severity: "error",
        message: `Test failed: ${fail[1]}`,
        check,
      })
      location = undefined
    }
  }
  return { findings, failedTests: [...failed] }
}

const vitestOrJest =
  (style: "vitest" | "jest"): Parser =>
  (output, dir, check) => {
    const findings: GateFinding[] = []
    const failed = new Set<string>()
    const pattern =
      style === "vitest"
        ? /^\s*(?:FAIL|×)\s+(\S+\.[cm]?[jt]sx?)(?:\s*>\s*(.+))?$/gm
        : /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?)/gm
    for (const match of output.matchAll(pattern)) {
      const file = relative(dir, match[1]!)
      failed.add(file)
      findings.push({
        file,
        rule: "test/failed",
        severity: "error",
        message: match[2] ? `Test failed: ${match[2].trim()}` : "Test file has failures",
        check,
      })
    }
    for (const match of output.matchAll(/^\s*● (.+)$/gm))
      if (findings.length && !findings.some((item) => item.message.includes(match[1]!)))
        findings.push({
          file: [...failed].at(-1) ?? ".",
          rule: "test/failed",
          severity: "error",
          message: `Test failed: ${match[1]}`,
          check,
        })
    return { findings, failedTests: [...failed] }
  }

const pytest: Parser = (output, dir, check) => {
  const findings: GateFinding[] = []
  const failed = new Set<string>()
  for (const match of output.matchAll(/^(?:FAILED|ERROR) (\S+?\.py)(?:::(\S+))?(?: - (.+))?$/gm)) {
    const file = relative(dir, match[1]!)
    failed.add(file)
    findings.push({
      file,
      rule: "test/failed",
      severity: "error",
      message: `Test failed: ${match[2] ?? file}${match[3] ? ` — ${match[3]}` : ""}`,
      check,
    })
  }
  return { findings, failedTests: [...failed] }
}

const goTest: Parser = (output, _dir, check) => {
  const findings: GateFinding[] = []
  const failed = new Set<string>()
  for (const match of output.matchAll(/^--- FAIL: (\S+)/gm))
    findings.push({ file: ".", rule: "test/failed", severity: "error", message: `Test failed: ${match[1]}`, check })
  for (const match of output.matchAll(/^\s+(\S+_test\.go):(\d+):/gm)) failed.add(match[1]!)
  return { findings, failedTests: [...failed] }
}

const cargoTest: Parser = (output, _dir, check) => ({
  findings: [...output.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((match) => ({
    file: ".",
    rule: "test/failed",
    severity: "error" as const,
    message: `Test failed: ${match[1]}`,
    check,
  })),
  failedTests: [],
})

/** Fallback: any "path:line[:col]" mention of an existing-looking source path. */
const generic: Parser = (output, dir, check) => {
  const findings: GateFinding[] = []
  const seen = new Set<string>()
  for (const match of output.matchAll(
    /(?:^|\s)((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[a-zA-Z]{1,5}):(\d+)(?::(\d+))?:?\s*(.*)$/gm,
  )) {
    const key = `${match[1]}:${match[2]}`
    if (seen.has(key) || findings.length >= 50) continue
    seen.add(key)
    findings.push({
      file: relative(dir, match[1]!),
      line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}),
      rule: `${check}/error`,
      severity: "error",
      message: match[4]?.trim() || "reported here",
      check,
    })
  }
  return { findings, failedTests: [] }
}

const PARSERS: Record<ParserId, Parser> = {
  tsc,
  biome,
  eslint,
  prettier,
  ruff,
  "ruff-format": ruffFormat,
  mypy,
  cargo,
  gofmt,
  "go-vet": goVet,
  "bun-test": bunTest,
  vitest: vitestOrJest("vitest"),
  jest: vitestOrJest("jest"),
  pytest,
  "go-test": goTest,
  "cargo-test": cargoTest,
  generic,
}

export function parseOutput(parser: ParserId, output: string, dir: string, check: string): ParsedOutput {
  try {
    return PARSERS[parser](output, dir, check)
  } catch {
    return none()
  }
}
