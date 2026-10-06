// Execute one hook handler with Claude Code's I/O contract:
// - command: exec form when `args` is set, else `sh -c`; JSON input on stdin;
//   exit 0 = success (stdout is JSON when it starts with "{" and ends with "}",
//   else plain text), exit 2 = blocking (stderr is the reason), other codes are
//   non-blocking errors unless stdout is valid JSON, which then decides.
// - http: POST the input; 2xx JSON body decides, anything else is non-blocking.
// - prompt: evaluated through an injected model call; {ok, reason, impossible}.
// - mcp_tool and agent: not available in the bridge (reported as skipped).
import { type RunResult, run } from "../util/proc.ts"
import type { HookHandler } from "./spec.ts"

export type OutcomeStatus = "ok" | "blocked" | "error" | "timeout" | "skipped"

export interface HandlerOutcome {
  readonly status: OutcomeStatus
  readonly exitCode?: number | null
  /** Parsed JSON output (valid object), when the handler printed one. */
  readonly json?: Record<string, any>
  /** Plain-text stdout (not JSON). */
  readonly text?: string
  readonly stderr?: string
  readonly error?: string
  readonly durationMs: number
}

export interface RunContext {
  readonly root: string
  readonly event: string
  readonly input: Record<string, unknown>
  readonly signal?: AbortSignal
  /** Model call for prompt hooks; absent means prompt hooks are skipped. */
  readonly generate?: (prompt: string, model?: string) => Promise<string>
}

const DEFAULT_TIMEOUT_S: Record<string, number> = { UserPromptSubmit: 30 }

function timeoutMs(handler: HookHandler, event: string): number {
  if (handler.timeout) return handler.timeout * 1000
  if (handler.type === "prompt") return 30_000
  if (handler.type === "agent") return 60_000
  return (DEFAULT_TIMEOUT_S[event] ?? 600) * 1000
}

function classifyStdout(stdout: string): { json?: Record<string, any>; text?: string; parseError?: string } {
  const trimmed = stdout.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === "object" && !Array.isArray(value)) return { json: value }
      return { text: trimmed }
    } catch (error) {
      return { parseError: error instanceof Error ? error.message : String(error) }
    }
  }
  return { text: trimmed }
}

const PROJECT_DIR = ["$", "{CLAUDE_PROJECT_DIR}"].join("")
const substitute = (value: string, root: string) =>
  value.replaceAll(PROJECT_DIR, root).replaceAll("$CLAUDE_PROJECT_DIR", root)

async function runCommand(
  handler: Extract<HookHandler, { type: "command" }>,
  context: RunContext,
): Promise<HandlerOutcome> {
  const started = Date.now()
  const argv = handler.args
    ? [substitute(handler.command, context.root), ...handler.args.map((arg) => substitute(arg, context.root))]
    : ["sh", "-c", handler.command]
  let result: RunResult
  try {
    result = await run(argv, {
      cwd: context.root,
      timeoutMs: timeoutMs(handler, context.event),
      input: JSON.stringify(context.input),
      inheritEnv: true,
      env: { CLAUDE_PROJECT_DIR: context.root, ES_HOOK_EVENT: context.event },
      maxOutputBytes: 1_000_000,
      ...(context.signal ? { signal: context.signal } : {}),
    })
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    }
  }
  const durationMs = Date.now() - started
  if (result.timedOut)
    return { status: "timeout", error: `timed out after ${timeoutMs(handler, context.event) / 1000}s`, durationMs }
  const { json, text, parseError } = classifyStdout(result.stdout)
  const stderr = result.stderr.trim()
  if (result.code === 2)
    return { status: "blocked", exitCode: 2, ...(json ? { json } : {}), ...(text ? { text } : {}), stderr, durationMs }
  if (parseError)
    return { status: "error", exitCode: result.code, error: `invalid JSON output: ${parseError}`, stderr, durationMs }
  if (result.code === 0 || json)
    return {
      status: "ok",
      exitCode: result.code,
      ...(json ? { json } : {}),
      ...(text ? { text } : {}),
      stderr,
      durationMs,
    }
  return {
    status: "error",
    exitCode: result.code,
    error: `exit ${result.code}: ${stderr.split("\n")[0] ?? ""}`,
    stderr,
    durationMs,
  }
}

async function runHttp(handler: Extract<HookHandler, { type: "http" }>, context: RunContext): Promise<HandlerOutcome> {
  const started = Date.now()
  const allowed = new Set(handler.allowedEnvVars ?? [])
  const headers: Record<string, string> = { "content-type": "application/json" }
  for (const [key, value] of Object.entries(handler.headers ?? {}))
    headers[key] = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) =>
      allowed.has(name) ? (process.env[name] ?? "") : "",
    )
  try {
    const response = await fetch(handler.url, {
      method: "POST",
      headers,
      body: JSON.stringify(context.input),
      signal: context.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs(handler, context.event))])
        : AbortSignal.timeout(timeoutMs(handler, context.event)),
    })
    const body = await response.text()
    const durationMs = Date.now() - started
    if (!response.ok) return { status: "error", error: `HTTP ${response.status}`, durationMs }
    if (!body.trim()) return { status: "ok", durationMs }
    const { json } = classifyStdout(body)
    return json ? { status: "ok", json, durationMs } : { status: "error", error: "non-JSON response body", durationMs }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError"
    return {
      status: timedOut ? "timeout" : "error",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    }
  }
}

async function runPrompt(
  handler: Extract<HookHandler, { type: "prompt" }>,
  context: RunContext,
): Promise<HandlerOutcome> {
  const started = Date.now()
  if (!context.generate)
    return { status: "skipped", error: "prompt hooks need a model call; none is available here", durationMs: 0 }
  const input = JSON.stringify(context.input)
  const prompt = handler.prompt.includes("$ARGUMENTS")
    ? handler.prompt.replaceAll("$ARGUMENTS", input)
    : `${handler.prompt}\n\n${input}`
  try {
    const reply = await Promise.race([
      context.generate(
        `${prompt}\n\nRespond with only a JSON object: {"ok": true|false, "reason": "…", "impossible": true|false}.`,
        handler.model,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("prompt hook timed out")), timeoutMs(handler, context.event)),
      ),
    ])
    const match = /\{[\s\S]*\}/.exec(reply)
    const verdict = match ? JSON.parse(match[0]) : undefined
    if (!verdict || typeof verdict.ok !== "boolean")
      return { status: "error", error: "prompt hook reply had no {ok} verdict", durationMs: Date.now() - started }
    return { status: "ok", json: { promptVerdict: verdict }, durationMs: Date.now() - started }
  } catch (error) {
    return {
      status: /timed out/.test(String(error)) ? "timeout" : "error",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    }
  }
}

export async function runHandler(handler: HookHandler, context: RunContext): Promise<HandlerOutcome> {
  switch (handler.type) {
    case "command":
      return runCommand(handler, context)
    case "http":
      return runHttp(handler, context)
    case "prompt":
      return runPrompt(handler, context)
    default:
      return {
        status: "skipped",
        error: `${handler.type} hooks are not supported by this harness bridge`,
        durationMs: 0,
      }
  }
}
