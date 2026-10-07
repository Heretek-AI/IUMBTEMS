// Boots a real in-process OpenCode v2 host (published @opencode/sdk) wired to
// the scripted fake LLM. Plugins are loaded from disk through config, the same
// path a user install takes.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/sdk"
import { type FakeLLM, type Script, startFakeLLM } from "./fake-llm.ts"

export interface ToolOutcome {
  readonly name: string
  readonly status: string
  readonly input: unknown
  /** Text the tool returned, or its error message. */
  readonly text: string
}

export interface RunResult {
  readonly sessionID: string
  readonly context: readonly any[]
  readonly tools: readonly ToolOutcome[]
}

export interface Harness {
  readonly opencode: Awaited<ReturnType<typeof OpenCode.create>>
  readonly llm: FakeLLM
  readonly directory: string
  readonly location: { directory: string }
  /** Create a session, send one prompt, and wait for the agent loop to settle. */
  run(text: string, options?: { agent?: string; sessionID?: string }): Promise<RunResult>
  close(): Promise<void>
}

export interface PluginEntry {
  readonly path: string
  readonly options?: Record<string, unknown>
}

export interface HarnessOptions {
  readonly script?: Script
  readonly plugins?: ReadonlyArray<string | PluginEntry>
  readonly config?: Record<string, unknown>
  readonly files?: Record<string, string>
  /** Initialise a git repository and commit `files` (author "test"). */
  readonly git?: boolean
}

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
}

/** Flatten a session context into tool outcomes. */
export function toolOutcomes(context: readonly any[]): ToolOutcome[] {
  const out: ToolOutcome[] = []
  for (const message of context) {
    if (message?.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part?.type !== "tool") continue
      const state = part.state ?? {}
      const content = state.content
      const text =
        state.status === "error"
          ? String(state.error?.message ?? "")
          : typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((item: any) => item?.text ?? "").join("")
              : JSON.stringify(state.output ?? "")
      out.push({ name: part.name, status: state.status, input: state.input, text })
    }
  }
  return out
}

export async function boot(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "es-host-"))
  const configDir = await mkdtemp(path.join(tmpdir(), "es-host-config-"))
  for (const [file, content] of Object.entries(options.files ?? {})) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), content)
  }
  if (options.git) {
    await git(directory, "init", "-q", "-b", "main")
    await git(directory, "add", "-A")
    await git(
      directory,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    )
  }
  const llm = startFakeLLM(options.script)
  const previousConfigHome = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configDir
  const config = {
    model: "fake/scripted",
    providers: {
      fake: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: llm.url, apiKey: "test" },
        models: { scripted: { limit: { context: 100000, output: 4000 } } },
      },
    },
    plugins: (options.plugins ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.options ? { package: entry.path, options: entry.options } : entry.path,
    ),
    ...options.config,
  }
  const opencode = await OpenCode.create({
    config: { directory: configDir, project: false, content: JSON.stringify(config) },
    models: { fetch: false },
    fs: { filewatcher: false },
  } as any)
  const location = { directory }
  return {
    opencode,
    llm,
    directory,
    location,
    async run(text, runOptions = {}) {
      const sessionID =
        runOptions.sessionID ??
        (await opencode.sessions.create({ location, ...(runOptions.agent ? { agent: runOptions.agent } : {}) } as any))
          .id
      await opencode.sessions.prompt({ sessionID, text } as any)
      await opencode.sessions.wait({ sessionID } as any)
      const context = await opencode.sessions.context({ sessionID } as any)
      return { sessionID, context, tools: toolOutcomes(context) }
    },
    async close() {
      await opencode.close()
      llm.stop()
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousConfigHome
      await rm(directory, { recursive: true, force: true })
      await rm(configDir, { recursive: true, force: true })
    },
  }
}
