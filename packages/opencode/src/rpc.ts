// Server side of the human-only channel. Each mutating method needs a token
// from a preview made in the last two minutes over the same subject, so the
// human confirms exactly what the dialog showed (no swap between preview and
// confirm).
import { randomBytes } from "node:crypto"
import {
  type ApprovalStage,
  approvalSubject,
  commandSetHash,
  factoryLayout,
  factorySummary,
  hashJson,
  isTrusted,
  loadGatesConfig,
  recordApproval,
  trustProject,
  verifyControl,
  writeJson,
} from "@heretek-ai/es-core"
import type { Runtime } from "./runtime.ts"
import { pendingApprovals } from "./tools.ts"

interface Ticket {
  readonly kind: string
  readonly subject: string
  readonly expires: number
}

const TTL_MS = 120_000

export function createRpcHandlers(runtime: Runtime, notify: () => Promise<void>) {
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

  const trustSubject = async () => {
    const { config } = await loadGatesConfig(runtime.root)
    return { config, ...(await commandSetHash(runtime.root, config.commands)) }
  }

  return {
    status: async () => {
      const state = await runtime.factory.read()
      return {
        summary: factorySummary(state),
        stage: state?.stage ?? "NONE",
        pending: (await pendingApprovals(runtime.root)).map((item) => item.stage),
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
    approve: async (input: unknown, context: any) => {
      const { stage, user, token } = input as { stage: ApprovalStage; user: string; token: string }
      try {
        redeem(token, `approve:${stage}`, (await approvalSubject(runtime.root, stage)).subject)
        const record = await recordApproval(runtime.root, {
          stage,
          channel: "tui",
          approvedBy: user,
          stateDir: runtime.stateDir,
        })
        await writeJson(
          factoryLayout(runtime.root).pending,
          (await pendingApprovals(runtime.root)).filter((item) => item.stage !== stage),
        )
        if (stage === "frontier") {
          const state = await runtime.factory.read()
          if (!state) await runtime.factory.begin(`human:${user}`)
          if ((await runtime.factory.read())?.stage === "GRILL") await runtime.factory.beginResearch(`human:${user}`)
        }
        await notify()
        return { message: `Approved ${stage} as ${record.approvedBy}.` }
      } catch (error) {
        return refused(context, error)
      }
    },
    previewTrust: async () => {
      const { hash, lines } = await trustSubject()
      const trusted = await isTrusted(runtime.root, hash, runtime.stateDir)
      return {
        ok: lines.length > 0,
        title: trusted ? "Gate commands (already trusted)" : "Trust these gate commands?",
        lines: lines.length ? lines : ["No gate commands detected for this project."],
        problems: [],
        token: issue("trust", hash),
      }
    },
    trust: async (input: unknown, context: any) => {
      const { user, token } = input as { user: string; token: string }
      try {
        const { hash, lines } = await trustSubject()
        redeem(token, "trust", hash)
        await trustProject(runtime.root, hash, lines, { approvedBy: user, stateDir: runtime.stateDir })
        return { message: `Trusted ${lines.length} gate command line(s).` }
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
    resume: async (input: unknown, context: any) => {
      const { user, token, acceptControlDrift, raiseCeilingUSD, extendRuntime } = input as {
        user: string
        token: string
        acceptControlDrift?: boolean
        raiseCeilingUSD?: number
        extendRuntime?: boolean
      }
      try {
        redeem(token, "resume", (await runtime.factory.read())?.halt)
        const state = await runtime.factory.resume(user, {
          ...(acceptControlDrift ? { acceptControlDrift } : {}),
          ...(raiseCeilingUSD ? { raiseCeilingUSD } : {}),
          ...(extendRuntime ? { extendRuntime } : {}),
        })
        await notify()
        return { message: `Resumed at ${state.stage}.` }
      } catch (error) {
        return refused(context, error)
      }
    },
  }
}
