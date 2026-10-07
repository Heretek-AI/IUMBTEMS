// Mechanical enforcement in the host: every write, edit, patch and shell call
// from any agent passes through core's policy (canonical paths, control files,
// seat scopes); factory seats additionally stop on STOP or a halted run, run
// read-only shells under bubblewrap, and get fast gate feedback after edits.
import path from "node:path"
import {
  agentSpec,
  bwrapAvailable,
  checkStopFile,
  evaluateRead,
  evaluateShell,
  evaluateWrite,
  formatDiagnostics,
  formatReport,
  loadGatesConfig,
  readonlyWrap,
  runGates,
  seatOf,
  shellQuote,
  treeFingerprint,
} from "@heretek-ai/es-core"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { HOST_WEB_TOOLS } from "./agents.ts"
import type { Runtime } from "./runtime.ts"

const WRITE_TOOLS = new Set(["write", "edit"])

const PATCH_HEADERS = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "]

/** Files a v2 `patch` touches (add, update, delete and move targets). */
export function patchTargets(patchText: string): string[] {
  const targets: string[] = []
  for (const line of patchText.split("\n")) {
    const header = PATCH_HEADERS.find((prefix) => line.startsWith(prefix))
    const target = header ? line.slice(header.length).trimEnd() : ""
    if (target) targets.push(target)
  }
  return targets
}

const deny = (message: string): never => {
  throw new ToolError({ message })
}

const appendContent = (content: unknown, text: string) =>
  typeof content === "string"
    ? `${content}\n\n${text}`
    : Array.isArray(content)
      ? [...content, { type: "text", text }]
      : text

export function createPolicyHooks(runtime: Runtime) {
  const fingerprints = new Map<string, { dir: string; print: string }>()

  const before = async (event: { tool: string; agent: string; id: string; input: unknown }) => {
    const seat = seatOf(event.agent)
    const input = (event.input ?? {}) as Record<string, any>
    if (seat || event.tool.startsWith("es_")) {
      const stop = await checkStopFile(runtime.root)
      if (stop.stopped)
        deny(`The factory is stopped (.factory/STOP: ${stop.reason}). A human must remove it and resume.`)
    }
    if (seat && !event.tool.startsWith("es_")) {
      const state = await runtime.factory.read().catch(() => undefined)
      if (state?.stage === "HALTED")
        deny(`The factory is halted: ${state.halt?.reason}. Stop and report; a human must resume.`)
    }
    if (agentSpec(event.agent)?.web === "cached" && (HOST_WEB_TOOLS as readonly string[]).includes(event.tool))
      deny(
        `Seat "${event.agent}" gets web facts only through es_research_search and es_research_fetch (cached and citable); ${event.tool} is not available to it.`,
      )
    const context = await runtime.policy()
    if (WRITE_TOOLS.has(event.tool) && typeof input.path === "string") {
      const decision = evaluateWrite(context, event.agent, input.path)
      if (decision.effect === "deny") deny(decision.reason)
    }
    if (event.tool === "patch" && typeof input.patchText === "string")
      for (const target of patchTargets(input.patchText)) {
        const decision = evaluateWrite(context, event.agent, target)
        if (decision.effect === "deny") deny(decision.reason)
      }
    if (event.tool === "read" && typeof input.path === "string") {
      const decision = evaluateRead(context, event.agent, input.path)
      if (decision.effect === "deny") deny(decision.reason)
    }
    if (event.tool === "shell" && typeof input.command === "string") {
      const decision = evaluateShell(context, event.agent, input.command, { sandboxAvailable: bwrapAvailable() })
      if (decision.effect === "deny") deny(decision.reason)
      const cwd =
        typeof input.workdir === "string"
          ? path.resolve(runtime.root, input.workdir)
          : (context.worktree ?? runtime.root)
      if (decision.effect === "allow" && decision.mode === "readonly-sandbox") {
        event.input = { ...input, command: readonlyWrap(["sh", "-c", input.command], cwd).map(shellQuote).join(" ") }
      } else if (decision.effect === "allow" && decision.mode === "readonly-checked") {
        fingerprints.set(event.id, { dir: cwd, print: await treeFingerprint(cwd) })
      }
    }
  }

  const after = async (event: {
    tool: string
    agent: string
    id: string
    input: unknown
    status: string
    result?: any
  }) => {
    const seat = seatOf(event.agent)
    const checked = fingerprints.get(event.id)
    if (checked) {
      fingerprints.delete(event.id)
      if ((await treeFingerprint(checked.dir)) !== checked.print) {
        await runtime.factory
          .halt(`agent:${event.agent}`, `read-only seat ${event.agent} changed files via the shell`)
          .catch(() => undefined)
        if (event.status === "completed")
          event.result = {
            ...event.result,
            content: appendContent(
              event.result?.content,
              "VIOLATION: this read-only seat modified the checkout. The factory has been halted.",
            ),
          }
      }
    }
    if (event.status !== "completed") return
    const input = (event.input ?? {}) as Record<string, any>
    const files =
      WRITE_TOOLS.has(event.tool) && typeof input.path === "string"
        ? [input.path]
        : event.tool === "patch" && typeof input.patchText === "string"
          ? patchTargets(input.patchText)
          : []
    if (!files.length) return
    if (runtime.options.lspAfterEdit !== false) {
      const lines: string[] = []
      for (const file of files) {
        const absolute = path.resolve(runtime.root, file)
        const result = await runtime.lsp.diagnostics(absolute, { maxWaitMs: 4_000 }).catch(() => undefined)
        if (Array.isArray(result)) lines.push(...formatDiagnostics(runtime.root, absolute, result, 1))
      }
      if (lines.length)
        event.result = {
          ...event.result,
          content: appendContent(event.result?.content, `<diagnostics>\n${lines.join("\n")}\n</diagnostics>`),
        }
    }
    if (seat !== "programmer" || runtime.options.afterEdit === "off") return
    const worktree = (await runtime.policy()).worktree
    if (!worktree) return
    const { config } = await loadGatesConfig(runtime.root, worktree)
    const touched = files
      .map((file) => path.relative(worktree, path.resolve(runtime.root, file)))
      .filter((file) => !file.startsWith(".."))
    const report = await runGates({
      root: runtime.root,
      dir: worktree,
      scope: "touched",
      touched,
      config: {
        ...config,
        commands: config.commands.filter((check) => check.kind === "format" || check.kind === "lint"),
      },
      stateDir: runtime.stateDir,
    })
    if (report.findings.length || !report.passed)
      event.result = {
        ...event.result,
        content: appendContent(event.result?.content, `Gates after edit:\n${formatReport(report)}`),
      }
  }

  const evaluate = async (event: {
    agent?: string
    action: string
    resources: readonly string[]
    effect: "allow" | "deny" | "ask"
    message?: string
  }) => {
    const seat = seatOf(event.agent)
    const context = await runtime.policy()
    if (event.action === "edit" || event.action === "read") {
      const decisions = event.resources.map((resource) =>
        event.action === "edit"
          ? evaluateWrite(context, event.agent, resource)
          : evaluateRead(context, event.agent, resource),
      )
      const denied = decisions.find((decision) => decision.effect === "deny")
      if (denied && "reason" in denied) {
        event.effect = "deny"
        event.message = denied.reason
        return
      }
      const asked = decisions.find((decision) => decision.effect === "ask")
      if (asked && "reason" in asked && event.effect === "allow") {
        event.effect = "ask"
        event.message = asked.reason
        return
      }
      if (seat && event.effect === "ask") {
        // Autonomous seats never wait on a human: our policy decides.
        event.effect = event.action === "edit" ? "allow" : "deny"
        if (event.effect === "deny")
          event.message = "Autonomous factory seats may not read files the host guards (e.g. .env)."
      }
      return
    }
    if (seat && event.action === "external_directory") {
      // Sonar S5443 flags the /tmp literal; this is an access check, not temp-file creation.
      const tmp = event.resources.every((resource) => resource === "/tmp/*" || resource.startsWith("/tmp/")) // NOSONAR
      event.effect = tmp ? "allow" : "deny"
      if (!tmp) event.message = "Factory seats stay inside the project (and /tmp)."
      return
    }
    if (seat && event.effect === "ask") {
      event.effect = "deny"
      event.message = `Autonomous factory seat "${event.agent}" cannot wait for a human approval of "${event.action}".`
    }
  }

  const shellEnv = (event: { env: Record<string, string | undefined> }) => {
    for (const key of Object.keys(event.env)) if (/^OPENCODE_(SERVER_)?PASSWORD$/.test(key)) delete event.env[key]
  }

  return { before, after, evaluate, shellEnv }
}
