// Opt-in behaviour evals: each case is one real `opencode run` turn in an
// isolated workspace (its own project, HOME and XDG dirs) that loads the local
// plugin with the configured model. The JSON event stream carries no cost, so
// spend is bounded by a hard step cap (the process is killed at the first step
// over it) plus a timeout: cost ≤ steps × (context + output) × price.
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
}

export interface EvalWorkspace {
  /** The project directory (a fresh git repo with opencode.json). */
  readonly dir: string
  /** HOME and XDG dirs for the run, so no global config or plugin leaks in. */
  readonly home: string
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
  await mkdir(dir, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(
    path.join(dir, "opencode.json"),
    `${JSON.stringify(
      {
        model: options.model,
        ...(options.providers ? { providers: options.providers } : {}),
        plugins: [{ package: options.pluginDir, options: { pr: "off", stateDir: path.join(base, "state") } }],
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
  return { dir, home, cleanup: () => rm(base, { recursive: true, force: true }) }
}

export interface EvalRunOptions {
  /** Absolute path of the opencode CLI. */
  readonly binary: string
  readonly maxSteps: number
  readonly timeoutMs: number
  /** Base environment (provider API keys come from here). */
  readonly env?: NodeJS.ProcessEnv
}

export interface EvalResult {
  readonly id: string
  readonly pass: boolean
  readonly exitCode: number | null
  readonly capped: boolean
  readonly timedOut: boolean
  readonly transcript: EvalTranscript
  readonly failures: readonly string[]
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
  let capped = false
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, options.timeoutMs)
  const stderr: string[] = []
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)))
  for await (const line of createInterface({ input: child.stdout! })) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { type?: string }
      events.push(event)
      if (event.type === "step_start" && ++steps > options.maxSteps && !capped) {
        capped = true
        child.kill("SIGKILL")
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
    ...(timedOut ? [`timed out after ${options.timeoutMs} ms`] : []),
    ...(exitCode !== 0 && !capped && !timedOut
      ? [`exit ${exitCode}${stderr.length ? `: ${stderr.join("").trim().slice(-300)}` : ""}`]
      : []),
    ...grade.failures,
  ]
  return { id: testCase.id, pass: failures.length === 0, exitCode, capped, timedOut, transcript, failures }
}
