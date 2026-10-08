// Server side of the TUI previews. Human-only mutations (approve, trust,
// resume) happen at a terminal with the passphrase-sealed key, never via RPC:
// the TUI previews, then points at `es approve`, `es trust`, `es factory
// resume`. Only lspInstall still mutates via a preview token.
import { randomBytes } from "node:crypto"
import {
  type ApprovalStage,
  allAudits,
  approvalSubject,
  capabilityLoss,
  commandSetHash,
  describeTarget,
  eventLine,
  factorySummary,
  footerLine,
  type HookEngine,
  hashJson,
  headerLine,
  headline,
  installServer,
  isTrusted,
  loadGatesConfig,
  readFrontier,
  readIdeas,
  readLiveness,
  readPlan,
  readResult,
  readScores,
  recordConsent,
  researchLine,
  seatLine,
  treeCounts,
  verifyControl,
} from "@heretek-ai/es-core"
import type { Runtime } from "./runtime.ts"

interface Ticket {
  readonly kind: string
  readonly subject: string
  readonly expires: number
}

const TTL_MS = 120_000

export function createRpcHandlers(
  runtime: Runtime,
  _notify: () => Promise<void>,
  hooks?: HookEngine,
  live: { readonly paused?: () => string | undefined } = {},
) {
  const tickets = new Map<string, Ticket>()
  const issue = (kind: string, subject: unknown) => {
    const token = randomBytes(12).toString("hex")
    tickets.set(token, { kind, subject: hashJson(subject), expires: Date.now() + TTL_MS })
    return token
  }
  const redeem = (token: string, kind: string, subject: unknown) => {
    const ticket = tickets.get(token)
    tickets.delete(token)
    if (!ticket || ticket.kind !== kind || ticket.expires < Date.now())
      throw new Error("The confirmation expired or does not match; preview again.")
    if (ticket.subject !== hashJson(subject))
      throw new Error("What you confirmed changed since the preview; preview again.")
  }
  const refused = (context: any, error: unknown) =>
    context.error("refused", error instanceof Error ? error.message : String(error), {
      reason: error instanceof Error ? error.message : String(error),
    })

  /** Everything a trust approval covers: gate commands and project hooks. */
  const trustSubject = async () => {
    const { config } = await loadGatesConfig(runtime.root)
    const gates = await commandSetHash(runtime.root, config.commands)
    await hooks?.reload()
    const hookStatus = hooks?.status()
    const hookHash = hookStatus?.projectHash ?? ""
    return {
      gates,
      hooks: { hash: hookHash, lines: hookStatus?.projectLines ?? [] },
      lines: [...gates.lines, ...(hookStatus?.projectLines ?? [])],
      key: { gates: gates.hash, hooks: hookHash },
    }
  }

  return {
    status: async () => {
      const state = await runtime.factory.read()
      const liveness = await readLiveness(runtime.root, state)
      const paused = live.paused?.()
      const footer = footerLine(state, liveness, paused)
      return {
        summary: await runtime.factory.summary(state),
        stage: state?.stage ?? "NONE",
        pending: liveness.pending.map((item) => item.stage),
        headline: headline(state, liveness),
        ...(footer ? { footer } : {}),
        ...(paused ? { paused } : {}),
      }
    },
    configState: async () => ({
      config: JSON.stringify(runtime.config),
      sources: [...runtime.configSources],
      warnings: [...runtime.warnings],
    }),
    factoryState: async () => {
      const state = await runtime.factory.read()
      const frontier = await readFrontier(runtime.root).catch(() => undefined)
      const liveness = await readLiveness(runtime.root, state)
      const research = researchLine(liveness)
      const paused = live.paused?.()
      return {
        headline: headline(state, liveness),
        ...(state ? { header: headerLine(state, liveness) } : {}),
        seats: liveness.seats.map((seat) => seatLine(liveness, seat)),
        ...(research ? { research } : {}),
        events: liveness.events.map(eventLine),
        ...(paused ? { paused } : {}),
        ...(frontier ? { tree: treeCounts(frontier) } : {}),
        stage: state?.stage ?? "NONE",
        ...(state?.runId ? { runId: state.runId } : {}),
        ...(state?.halt ? { halt: state.halt.reason } : {}),
        ...(state?.release?.prUrl ? { release: state.release.prUrl } : {}),
        ...(state?.activePhase ? { activePhase: state.activePhase } : {}),
        spend: {
          usd: state?.spend.usd ?? 0,
          estimated: state?.spend.estimated ?? false,
          ...(state?.spendCeilingUSD ? { ceilingUSD: state.spendCeilingUSD } : {}),
        },
        phases: (state?.phases ?? []).map((phase) => ({
          id: phase.id,
          title: phase.title,
          status: phase.status,
          failures: phase.failures,
          qa: Object.fromEntries(Object.entries(phase.qa).filter(([, verdict]) => verdict !== undefined)),
        })),
        pending: liveness.pending.map((item) => item.stage),
        audits: (state ? allAudits(state) : []).map((audit) => ({
          id: audit.id,
          target: describeTarget(audit.target),
          status: audit.status,
          round: audit.round,
          thesis: audit.thesis?.verdict ?? "-",
          antithesis: audit.antithesis?.verdict ?? "-",
          ...(audit.tiebreak ? { tiebreak: audit.tiebreak.verdict } : {}),
        })),
      }
    },
    lspState: async () => {
      const status = await runtime.lsp.status()
      const settings = await runtime.lsp.settings()
      const servers = []
      for (const server of settings.servers) {
        const command = await runtime.lsp.command(server, runtime.root)
        servers.push({
          id: server.id,
          extensions: server.extensions,
          available: Array.isArray(command),
          command: Array.isArray(command) ? command.join(" ") : String((command as any)?.unavailable ?? "unavailable"),
          running: status.running.filter((item) => item.id === server.id).length,
        })
      }
      return { enabled: status.enabled, servers, diagnostics: status.diagnostics }
    },
    hooksState: async () => {
      await hooks?.reload()
      const status = hooks?.status()
      return {
        handlers: status?.handlers ?? 0,
        projectHandlers: status?.projectHandlers ?? 0,
        trusted: status?.trusted ?? true,
        projectLines: status?.projectLines ?? [],
        diagnostics: status?.diagnostics ?? [],
        recent: hooks?.recent.slice(-10) ?? [],
        loss: capabilityLoss(hooks?.list() ?? [], "opencode").map((item) => ({
          source: item.source,
          event: item.event,
          handler: item.handler,
          support: item.support,
          reason: item.reason,
        })),
      }
    },
    brainstormState: async () => {
      const plan = await readPlan(runtime.root).catch(() => undefined)
      if (!plan) return { active: false }
      const ideas = await readIdeas(runtime.root).catch(() => [])
      const scores = await readScores(runtime.root).catch(() => [])
      const result = await readResult(runtime.root).catch(() => undefined)
      const survivors = ideas.filter((idea) => !idea.duplicateOf)
      return {
        active: true,
        brief: plan.brief.idea,
        lenses: plan.lenses,
        ideas: survivors.length,
        duplicates: ideas.length - survivors.length,
        scored: scores.length,
        coverage: Object.fromEntries(
          plan.lenses.map((lens) => [lens, survivors.filter((idea) => idea.lens === lens).length]),
        ),
        shortlist: (result?.shortlist ?? []).map((entry) => ({
          id: entry.id,
          total: entry.total,
          outlier: entry.outlier,
          title: result?.ideas.find((idea) => idea.id === entry.id)?.title ?? entry.id,
        })),
        gaps: result?.gaps ?? [],
        complete: Boolean(result),
      }
    },
    previewApproval: async (input: unknown) => {
      const { stage } = input as { stage: ApprovalStage }
      try {
        const subject = await approvalSubject(runtime.root, stage)
        return {
          ok: true,
          title: `Approve ${stage}?`,
          lines: [
            ...subject.summary,
            "",
            ...subject.subject.map((item) => `${item.sha256.slice(0, 12)}  ${item.path}`),
          ],
          problems: [],
          token: issue(`approve:${stage}`, subject.subject),
        }
      } catch (error) {
        return {
          ok: false,
          title: `Cannot approve ${stage}`,
          lines: [],
          problems: [error instanceof Error ? error.message : String(error)],
        }
      }
    },
    previewTrust: async () => {
      const subject = await trustSubject()
      const trusted =
        (await isTrusted(runtime.root, subject.gates.hash, runtime.stateDir)) &&
        (!subject.hooks.hash || (await isTrusted(runtime.root, subject.hooks.hash, runtime.stateDir, "hooks")))
      return {
        ok: subject.lines.length > 0,
        title: trusted ? "Gate commands and hooks (already trusted)" : "Trust these gate commands and project hooks?",
        lines: subject.lines.length ? subject.lines : ["No gate commands or project hooks detected."],
        problems: [],
        token: issue("trust", subject.key),
      }
    },
    previewLspInstall: async (input: unknown) => {
      const { id } = input as { id: string }
      const server = (await runtime.lsp.settings()).servers.find((item) => item.id === id)
      if (!server?.install)
        return {
          ok: false,
          title: `Cannot install ${id}`,
          lines: [],
          problems: [server ? `${id} has no pinned install` : `unknown server ${id}`],
        }
      return {
        ok: true,
        title: `Install ${id}?`,
        lines: [
          ...server.install.packages.map((pkg) => `${pkg.name}@${pkg.version}  ${pkg.integrity.slice(0, 32)}…`),
          "Downloaded from npm, verified against the pinned sha512, installed with scripts disabled into your state dir.",
        ],
        problems: [],
        token: issue(`lsp:${id}`, server.install),
      }
    },
    lspInstall: async (input: unknown, context: any) => {
      const { id, user, token } = input as { id: string; user: string; token: string }
      try {
        const server = (await runtime.lsp.settings()).servers.find((item) => item.id === id)
        if (!server?.install) throw new Error(`${id} has no pinned install`)
        redeem(token, `lsp:${id}`, server.install)
        await recordConsent(id, true, runtime.stateDir)
        const bin = await installServer(server, { stateDir: runtime.stateDir })
        return { message: `Installed ${id} (${bin}) for ${user}.` }
      } catch (error) {
        return refused(context, error)
      }
    },
    previewResume: async () => {
      const state = await runtime.factory.read()
      if (state?.stage !== "HALTED")
        return {
          ok: false,
          title: "Nothing to resume",
          lines: [factorySummary(state)],
          problems: ["The factory is not halted."],
        }
      const control = await verifyControl(runtime.root)
      return {
        ok: true,
        title: "Resume the factory?",
        lines: [
          `Halted: ${state.halt?.reason}`,
          `Spend: $${state.spend.usd.toFixed(2)} of $${state.spendCeilingUSD ?? "?"}`,
          ...(control.clean
            ? []
            : ["Control-file drift (accepting it re-baselines):", ...control.violations.map((item) => `  ${item}`)]),
        ],
        problems: [],
        token: issue("resume", state.halt),
      }
    },
  }
}
