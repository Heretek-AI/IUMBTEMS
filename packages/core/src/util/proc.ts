// Subprocess execution with timeouts, output caps and a scrubbed environment.
// Read-only mode uses bubblewrap with a discardable tmpfs overlay on the
// working directory (writes vanish when the process exits); without bwrap the
// caller falls back to an allowlist plus a post-run diff check (see sandbox.ts).
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"

/** Absolute path of an executable found on PATH (absolute entries only, no shell), or undefined. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return undefined
}

export interface RunOptions {
  readonly cwd: string
  readonly timeoutMs?: number
  /** Per-stream cap; output beyond it is dropped and `truncated` is set. */
  readonly maxOutputBytes?: number
  /** Extra variables, applied after scrubbing (explicit values are trusted). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Process variables to pass through beyond the default allowlist. */
  readonly passEnv?: readonly string[]
  /** Inherit the full parent environment (trusted hooks, like Claude Code). Overrides scrubbing. */
  readonly inheritEnv?: boolean
  readonly input?: string
  /** "readonly": bwrap ro root + tmp-overlay on cwd. Throws if bwrap is unavailable. */
  readonly sandbox?: "none" | "readonly"
  /** Disable network inside the sandbox. */
  readonly offline?: boolean
  readonly signal?: AbortSignal
}

export interface RunResult {
  readonly command: readonly string[]
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly truncated: boolean
  readonly durationMs: number
  readonly sandboxed: boolean
}

const DEFAULT_PASS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "NODE_OPTIONS",
  "BUN_INSTALL",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "VIRTUAL_ENV",
  "PYTHONPATH",
  "JAVA_HOME",
  "CI",
]

const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|AUTH|SESSION|COOKIE)/i

/** Environment for child processes: allowlisted, never secret-looking, plus explicit extras. */
export function scrubbedEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
  pass: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of [...DEFAULT_PASS, ...pass]) {
    const value = source[key]
    if (value === undefined) continue
    if (!pass.includes(key) && SECRETISH.test(key)) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value
  return out
}

let bwrapCache: boolean | undefined
export function bwrapAvailable(): boolean {
  if (bwrapCache !== undefined) return bwrapCache
  try {
    // bwrap is resolved from PATH by design (it may be absent).
    const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--", "true"], { timeout: 5000 }) // NOSONAR
    bwrapCache = probe.status === 0
  } catch {
    bwrapCache = false
  }
  return bwrapCache
}

/** For tests: forget the cached bwrap probe. */
export const resetBwrapProbe = () => {
  bwrapCache = undefined
}

export function readonlyWrap(command: readonly string[], cwd: string, offline = false): string[] {
  return [
    "bwrap",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--overlay-src",
    cwd,
    "--tmp-overlay",
    cwd,
    "--chdir",
    cwd,
    "--die-with-parent",
    "--unshare-pid",
    ...(offline ? ["--unshare-net"] : []),
    "--",
    ...command,
  ]
}

export function run(command: readonly string[], options: RunOptions): Promise<RunResult> {
  if (command.length === 0) throw new Error("run: empty command")
  const timeoutMs = options.timeoutMs ?? 120_000
  const cap = options.maxOutputBytes ?? 1_000_000
  const sandboxed = options.sandbox === "readonly"
  if (sandboxed && !bwrapAvailable()) throw new Error("readonly sandbox requested but bwrap is unavailable")
  const argv = sandboxed ? readonlyWrap(command, options.cwd, options.offline) : [...command]
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.inheritEnv
        ? (Object.fromEntries(
            Object.entries({ ...process.env, ...options.env }).filter(([, value]) => value !== undefined),
          ) as Record<string, string>)
        : scrubbedEnv(options.env, options.passEnv),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    })
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const sizes = { stdout: 0, stderr: 0 }
    let truncated = false
    let timedOut = false
    const collect = (stream: "stdout" | "stderr") => (data: Buffer) => {
      if (sizes[stream] >= cap) {
        truncated = true
        return
      }
      const room = cap - sizes[stream]
      const piece = data.length > room ? data.subarray(0, room) : data
      if (data.length > room) truncated = true
      chunks[stream].push(piece)
      sizes[stream] += piece.length
    }
    child.stdout!.on("data", collect("stdout"))
    child.stderr!.on("data", collect("stderr"))
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = () => kill()
    options.signal?.addEventListener("abort", onAbort, { once: true })
    child.on("error", (error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      reject(error)
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve({
        command,
        code,
        signal,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        sandboxed,
      })
    })
    // A child that exits without reading stdin must not crash us with EPIPE.
    child.stdin!.on("error", () => {})
    if (options.input !== undefined) child.stdin!.end(options.input)
    else child.stdin!.end()
  })
}

/** Split a simple shell-free command string ("npx tsc --noEmit") into argv. Quotes supported, no expansion. */
export function splitCommand(command: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | undefined
  let started = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && i + 1 < command.length) current += command[++i]
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) out.push(current)
      current = ""
      started = false
      continue
    }
    current += char
    started = true
  }
  if (quote) throw new Error(`Unterminated quote in command: ${command}`)
  if (started) out.push(current)
  return out
}

/** Convenient helper to run a string command directly. */
export function runCommand(command: string, options: RunOptions): Promise<RunResult> {
  return run(splitCommand(command), options)
}
