// Opt-in behaviour evals: each case is one real `opencode run` turn in an
// isolated workspace (its own project, HOME and XDG dirs) that loads the local
// plugin with the configured model. Spend is bounded three ways: a hard step
// cap (the process is killed at the first step over it), a timeout, and an
// optional USD budget read from the stream's `step_finish` cost (killed at the
// first step that crosses it; 0 for a model with no configured price).
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { findExecutable } from "../util/proc.ts"
import type { FireSpec } from "./fires.ts"
import { type EvalChecks, type EvalTranscript, gradeTranscript, readTranscript } from "./grade.ts"

export interface EvalCase {
  readonly id: string
  readonly description: string
  readonly agent: string
  readonly prompt: string
  readonly checks?: EvalChecks
  /** Project files to seed the workspace with (relative path → content). */
  readonly files?: Readonly<Record<string, string>>
  /** A fire: after the turn, a deterministic grader scores what the seats left on disk. */
  readonly fire?: FireSpec
  /** This case's step cap, sized for a model that makes one call per step (see `caseStepCap`). */
  readonly maxSteps?: number
  /**
   * When set, the case is explicitly model-limited (#65): the checked-in
   * model systematically misses this, with the reason stated. The report
   * marks it so a red row reads as a known limit, not a regression.
   */
  readonly modelLimited?: string
}

/** Step cap for a case that sets no `maxSteps` of its own. */
export const DEFAULT_CASE_STEPS = 6

/**
 * The step cap a case runs under: its own `maxSteps` (sized for a model that
 * makes one call per step), bounded by the run-wide ceiling.
 */
export function caseStepCap(caseMaxSteps: number | undefined, ceiling: number): number {
  return Math.min(caseMaxSteps ?? DEFAULT_CASE_STEPS, ceiling)
}

export interface EvalWorkspace {
  /** The project directory (a fresh git repo with opencode.json). */
  readonly dir: string
  /** HOME and XDG dirs for the run, so no global config or plugin leaks in. */
  readonly home: string
  /** Isolated engine state dir the plugin uses (signing key, trust store). */
  readonly stateDir: string
  cleanup(): Promise<void>
}

/** A fresh project that loads `pluginDir` with `model`; `providers` adds provider blocks (tests). */
export async function evalWorkspace(options: {
  pluginDir: string
  model: string
  providers?: Record<string, unknown>
  /** Seed files (relative path → content), written before the run. */
  files?: Readonly<Record<string, string>>
}): Promise<EvalWorkspace> {
  const base = await mkdtemp(path.join(tmpdir(), "es-eval-"))
  const dir = path.join(base, "project")
  const home = path.join(base, "home")
  const stateDir = path.join(base, "state")
  await mkdir(dir, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(
    path.join(dir, "opencode.json"),
    `${JSON.stringify(
      {
        model: options.model,
        ...(options.providers ? { providers: options.providers } : {}),
        plugins: [{ package: options.pluginDir, options: { pr: "off", stateDir } }],
      },
      null,
      2,
    )}\n`,
  )
  for (const [file, content] of Object.entries(options.files ?? {})) {
    const target = path.join(dir, file)
    if (path.relative(dir, target).startsWith("..")) throw new Error(`seed file escapes the workspace: ${file}`)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  const git = findExecutable("git")
  if (git)
    await new Promise<void>((resolve) => {
      const child = spawn(git, ["init", "-q"], { cwd: dir, stdio: "ignore" })
      child.on("close", () => resolve())
      child.on("error", () => resolve())
    })
  return { dir, home, stateDir, cleanup: () => rm(base, { recursive: true, force: true }) }
}

export interface EvalRunOptions {
  /** Absolute path of the opencode CLI. */
  readonly binary: string
  readonly maxSteps: number
  readonly timeoutMs: number
  /** Spend this case may use (USD); the run is killed once its reported cost exceeds it. */
  readonly budgetUSD?: number
  /** Base environment (provider API keys come from here). */
  readonly env?: NodeJS.ProcessEnv
}

export interface EvalResult {
  readonly id: string
  readonly pass: boolean
  readonly exitCode: number | null
  readonly capped: boolean
  readonly timedOut: boolean
  readonly overBudget: boolean
  readonly transcript: EvalTranscript
  readonly failures: readonly string[]
  /** The raw event stream and stderr, kept as evidence for a failed case. */
  readonly events: readonly unknown[]
  readonly stderr: string
}

/** The child environment: the caller's env (for provider keys) with the workspace as PWD, HOME and XDG dirs. */
export function evalEnv(workspace: EvalWorkspace, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    // opencode resolves the project from PWD, not the spawn cwd.
    PWD: workspace.dir,
    HOME: workspace.home,
    XDG_CONFIG_HOME: path.join(workspace.home, ".config"),
    XDG_DATA_HOME: path.join(workspace.home, ".local", "share"),
    XDG_STATE_HOME: path.join(workspace.home, ".local", "state"),
    XDG_CACHE_HOME: path.join(workspace.home, ".cache"),
  }
}

export async function runEvalCase(
  testCase: EvalCase,
  workspace: EvalWorkspace,
  options: EvalRunOptions,
): Promise<EvalResult> {
  const child = spawn(
    options.binary,
    ["run", "--standalone", "--format", "json", "--agent", testCase.agent, testCase.prompt],
    { cwd: workspace.dir, env: evalEnv(workspace, options.env), stdio: ["ignore", "pipe", "pipe"] },
  )
  const events: unknown[] = []
  let steps = 0
  let spent = 0
  let capped = false
  let timedOut = false
  let overBudget = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, options.timeoutMs)
  const stderr: string[] = []
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)))
  for await (const line of createInterface({ input: child.stdout! })) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { type?: string; part?: { cost?: unknown } }
      events.push(event)
      if (event.type === "step_start" && ++steps > options.maxSteps && !capped) {
        capped = true
        child.kill("SIGKILL")
      }
      if (event.type === "step_finish" && typeof event.part?.cost === "number" && Number.isFinite(event.part.cost)) {
        spent += event.part.cost
        if (options.budgetUSD !== undefined && spent > options.budgetUSD && !overBudget) {
          overBudget = true
          child.kill("SIGKILL")
        }
      }
    } catch {
      // not an event line
    }
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode)
    else child.on("close", (code) => resolve(code))
  })
  clearTimeout(timer)
  const transcript = readTranscript(events)
  const grade = gradeTranscript(transcript, testCase.checks)
  const failures = [
    ...(capped ? [`step cap reached (${options.maxSteps})`] : []),
    ...(overBudget ? [`spend budget reached ($${spent.toFixed(4)} > $${options.budgetUSD})`] : []),
    ...(timedOut ? [`timed out after ${options.timeoutMs} ms`] : []),
    ...(exitCode !== 0 && !capped && !timedOut && !overBudget
      ? [`exit ${exitCode}${stderr.length ? `: ${stderr.join("").trim().slice(-300)}` : ""}`]
      : []),
    ...grade.failures,
  ]
  return {
    id: testCase.id,
    pass: failures.length === 0,
    exitCode,
    capped,
    timedOut,
    overBudget,
    transcript,
    failures,
    events,
    stderr: stderr.join(""),
  }
}
