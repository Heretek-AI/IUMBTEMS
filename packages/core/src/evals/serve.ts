// Static fixture server for behaviour evals (`bun run evals`). Some cases need
// a fetchable page without reaching the public web: the runner serves
// `evals/serve/` on 127.0.0.1 and substitutes {{SERVE_URL}} into case prompts.
// Localhost only, eval-time only; unknown paths 404 and `..` never escapes.
import { readFile } from "node:fs/promises"
import path from "node:path"

export interface ServeFixtures {
  readonly url: string
  stop(): void
}

const TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
}

/** Contain a request path inside the served dir; undefined escapes the root. */
export function resolveServePath(base: string, requestPath: string): string | undefined {
  const target = path.normalize(path.join(base, decodeURIComponent(requestPath)))
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) return undefined
  return target
}

export async function startServeFixtures(dir: string): Promise<ServeFixtures> {
  const base = path.resolve(dir)
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const target = resolveServePath(base, new URL(req.url).pathname)
      if (target === undefined) return new Response("not found", { status: 404 })
      const body = await readFile(target).catch(() => undefined)
      if (body === undefined) return new Response("not found", { status: 404 })
      return new Response(body, {
        headers: { "content-type": TYPES[path.extname(target)] ?? "application/octet-stream" },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/** Substitute the fixture server URL into a case prompt (no-op without one). */
export const renderEvalPrompt = (prompt: string, serveUrl: string): string =>
  prompt.replaceAll("{{SERVE_URL}}", serveUrl)

/**
 * Whether a case fetches from the loopback fixture server. Only those cases'
 * seat environment gets ES_RESEARCH_ALLOW_LOOPBACK=1 (the fetch SSRF guard
 * refuses loopback by default); every other case runs with the caller's
 * environment untouched, never a global allowance.
 */
export const usesFixtureServer = (prompt: string): boolean => prompt.includes("{{SERVE_URL}}")
