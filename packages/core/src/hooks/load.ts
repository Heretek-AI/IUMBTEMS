// Load hook definitions with Claude Code's merge rules: every source adds its
// handlers (none replaces another), identical handlers run once, and
// `disableAllHooks: true` in a source turns that source off. Project hooks are
// hash-pinned: they run only after a human trusts their exact content.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { canonicalJson, hashJson } from "../util/hash.ts"
import { parseJsonc } from "../util/jsonc.ts"
import { HookHandlerSchema, MatcherGroupSchema, type SourcedHandler } from "./spec.ts"

export interface HookSource {
  readonly file: string
  /** Project sources need trust; user sources are the user's own config. */
  readonly scope: "project" | "user"
}

export function hookSources(root: string, home = homedir(), xdgConfig = process.env.XDG_CONFIG_HOME): HookSource[] {
  const config = xdgConfig ?? path.join(home, ".config")
  return [
    { file: path.join(root, ".opencode", "hooks.json"), scope: "project" },
    { file: path.join(root, ".claude", "settings.json"), scope: "project" },
    { file: path.join(root, ".claude", "settings.local.json"), scope: "project" },
    { file: path.join(config, "opencode", "hooks.json"), scope: "user" },
    { file: path.join(home, ".claude", "settings.json"), scope: "user" },
  ]
}

export interface LoadedHooks {
  readonly handlers: SourcedHandler[]
  /** Project handlers only, for the trust hash. */
  readonly projectHandlers: SourcedHandler[]
  readonly diagnostics: string[]
  /** Content hash of the project hook set ("" when there are none). */
  readonly projectHash: string
  /** Human-readable lines describing the project hook set (trust dialog). */
  readonly projectLines: string[]
}

export async function loadHooks(root: string, sources = hookSources(root)): Promise<LoadedHooks> {
  const handlers: SourcedHandler[] = []
  const diagnostics: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const text = await readFile(source.file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const display = path.relative(root, source.file).startsWith("..") ? source.file : path.relative(root, source.file)
    let parsed: any
    try {
      parsed = parseJsonc(text)
    } catch (error) {
      diagnostics.push(
        `${display}: invalid JSON (${error instanceof Error ? error.message : String(error)}); its hooks are ignored`,
      )
      continue
    }
    if (parsed?.disableAllHooks === true) {
      diagnostics.push(`${display}: disableAllHooks is set; its hooks are off`)
      continue
    }
    const hooks = parsed?.hooks ?? (source.file.endsWith("hooks.json") ? parsed : undefined)
    if (!hooks || typeof hooks !== "object") continue
    for (const [event, groups] of Object.entries<unknown>(hooks)) {
      if (!Array.isArray(groups)) {
        diagnostics.push(`${display}: hooks.${event} must be an array of matcher groups`)
        continue
      }
      groups.forEach((group, index) => {
        const result = MatcherGroupSchema.safeParse(group)
        if (!result.success) {
          // Keep valid handlers of a partially invalid group, as far as possible.
          const raw = (group as { hooks?: unknown[]; matcher?: unknown }) ?? {}
          for (const item of Array.isArray(raw.hooks) ? raw.hooks : []) {
            const handler = HookHandlerSchema.safeParse(item)
            if (!handler.success)
              diagnostics.push(`${display}: hooks.${event}[${index}] has an invalid handler; skipped`)
          }
          return
        }
        for (const handler of result.data.hooks) {
          const key = canonicalJson({ event, matcher: result.data.matcher ?? "", handler })
          if (seen.has(key)) continue
          seen.add(key)
          handlers.push({
            event,
            matcher: result.data.matcher,
            handler,
            source: source.scope === "user" ? `user:${display}` : display,
          })
        }
      })
    }
  }
  const projectHandlers = handlers.filter((item) => !item.source.startsWith("user:"))
  const projectLines = projectHandlers.map((item) => {
    const what =
      item.handler.type === "command"
        ? `${item.handler.command}${item.handler.args ? ` ${item.handler.args.join(" ")}` : ""}`
        : item.handler.type === "http"
          ? `POST ${item.handler.url}`
          : item.handler.type === "mcp_tool"
            ? `mcp ${item.handler.server}.${item.handler.tool}`
            : `${item.handler.type}: ${item.handler.prompt.slice(0, 80)}`
    return `hook ${item.event}${item.matcher ? `(${item.matcher})` : ""}${item.handler.if ? ` if ${item.handler.if}` : ""} [${item.source}]: ${what}`
  })
  return {
    handlers,
    projectHandlers,
    diagnostics,
    projectHash: projectHandlers.length
      ? hashJson(
          projectHandlers.map((item) => ({ event: item.event, matcher: item.matcher ?? "", handler: item.handler })),
        )
      : "",
    projectLines,
  }
}
