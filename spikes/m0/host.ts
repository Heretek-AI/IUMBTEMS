// Boots a real in-process OpenCode v2 host (published @opencode/sdk) wired to
// the scripted fake LLM. Plugins are loaded from disk through config, the same
// path a user install takes.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/sdk"
import { startFakeLLM, type FakeLLM, type Script } from "./fake-llm"

export interface Harness {
  readonly opencode: Awaited<ReturnType<typeof OpenCode.create>>
  readonly llm: FakeLLM
  readonly directory: string
  readonly location: { directory: string }
  /** Create a session, send one prompt, and wait for the agent loop to settle. */
  run(text: string, options?: { agent?: string }): Promise<{ sessionID: string; context: readonly any[] }>
  close(): Promise<void>
}

export interface HarnessOptions {
  readonly script?: Script
  readonly plugins?: readonly string[]
  readonly config?: Record<string, unknown>
  readonly files?: Record<string, string>
}

export async function boot(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "es-m0-"))
  const configDir = path.join(directory, ".config")
  await mkdir(configDir, { recursive: true })
  for (const [file, content] of Object.entries(options.files ?? {})) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), content)
  }
  const llm = startFakeLLM(options.script)
  const config = {
    model: "fake/scripted",
    providers: {
      fake: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: llm.url, apiKey: "test" },
        models: { scripted: { limit: { context: 100000, output: 4000 } } },
      },
    },
    plugins: options.plugins ?? [],
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
      const session = await opencode.sessions.create({
        location,
        ...(runOptions.agent ? { agent: runOptions.agent } : {}),
      } as any)
      await opencode.sessions.prompt({ sessionID: session.id, text } as any)
      await opencode.sessions.wait({ sessionID: session.id } as any)
      const context = await opencode.sessions.context({ sessionID: session.id } as any)
      return { sessionID: session.id, context }
    },
    async close() {
      await opencode.close()
      llm.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
