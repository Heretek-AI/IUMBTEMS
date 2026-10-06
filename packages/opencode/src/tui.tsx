// Epistemic Swarm TUI plugin: the human-only dialogs. Approvals, trust and
// resume happen here (or in the `es` CLI), never through an agent tool. Each
// dialog shows a server-computed preview; confirming redeems that preview's
// token, so what the human saw is exactly what gets signed.
import { userInfo } from "node:os"
import { Plugin } from "@opencode/plugin/tui"
import { EsRpc } from "./rpc-def.ts"

type Preview = { ok: boolean; title: string; lines: string[]; problems: string[]; token?: string }

export default Plugin.define({
  id: "epistemic-swarm.tui",
  setup(context) {
    const rpc = context.client.rpc(EsRpc) as any
    const location = () => context.location ?? context.data.location.default()
    const call = (method: string, input: unknown = {}) => rpc[method](input, { location: location() })
    const user = userInfo().username
    const toast = (message: string, variant: "success" | "error" | "info" = "info") =>
      context.ui.toast.show({ title: "Epistemic Swarm", message, variant })

    const confirm = async (preview: Preview, label: string) => {
      if (!preview.ok || !preview.token) {
        await context.ui.dialog.alert({
          title: preview.title,
          message: [...preview.problems, ...preview.lines].join("\n"),
        })
        return undefined
      }
      const ok = await context.ui.dialog.confirm({
        title: preview.title,
        message: preview.lines.join("\n"),
        label: { confirm: label, cancel: "Cancel" },
      })
      return ok ? preview.token : undefined
    }

    const guarded = (fn: (input?: string) => Promise<void>) => async (input?: string) => {
      try {
        await fn(input)
      } catch (error: any) {
        toast(error?.data?.reason ?? error?.message ?? String(error), "error")
      }
    }

    const approve = guarded(async (input) => {
      const status = await call("status")
      const stage =
        input?.trim() ||
        (status.pending.length === 1
          ? status.pending[0]
          : await context.ui.dialog.select({
              title: "Approve which checkpoint?",
              options: [
                { title: "Frontier (design tree + spend ceiling)", value: "frontier" },
                { title: "Spec (roadmap + every GOAL.md)", value: "spec" },
              ],
            }))
      if (stage !== "frontier" && stage !== "spec") return
      const token = await confirm(await call("previewApproval", { stage }), "Approve")
      if (!token) return
      toast((await call("approve", { stage, user, token })).message, "success")
    })

    const trust = guarded(async () => {
      const token = await confirm(await call("previewTrust"), "Trust")
      if (!token) return
      toast((await call("trust", { user, token })).message, "success")
    })

    const resume = guarded(async () => {
      const preview: Preview = await call("previewResume")
      const token = await confirm(preview, "Resume")
      if (!token) return
      const drift = preview.lines.some((line) => line.startsWith("Control-file drift"))
      let raiseCeilingUSD: number | undefined
      if (/spend ceiling/i.test(preview.lines[0] ?? "")) {
        const raised = await context.ui.dialog.prompt({ title: "New spend ceiling (USD)", placeholder: "e.g. 50" })
        raiseCeilingUSD = raised ? Number(raised) : undefined
      }
      const extendRuntime = /runtime cap/i.test(preview.lines[0] ?? "")
      const result = await call("resume", {
        user,
        token,
        ...(drift ? { acceptControlDrift: true } : {}),
        ...(raiseCeilingUSD ? { raiseCeilingUSD } : {}),
        ...(extendRuntime ? { extendRuntime: true } : {}),
      })
      toast(result.message, "success")
    })

    const lspInstall = guarded(async (input) => {
      const id =
        input?.trim() ||
        (await context.ui.dialog.prompt({
          title: "Install which language server?",
          placeholder: "typescript, pyright",
        }))
      if (!id) return
      const token = await confirm(await call("previewLspInstall", { id }), "Install")
      if (!token) return
      toast((await call("lspInstall", { id, user, token })).message, "success")
    })

    const status = guarded(async () => {
      const result = await call("status")
      await context.ui.dialog.alert({
        title: "Factory",
        message: result.summary.replace(/<\/?factory-state>/g, "").trim(),
      })
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "es.approve",
          title: "Epistemic Swarm: approve a checkpoint",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-approve", arguments: true },
          run: approve,
        },
        {
          id: "es.trust",
          title: "Epistemic Swarm: trust gate commands",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-trust" },
          run: trust,
        },
        {
          id: "es.resume",
          title: "Epistemic Swarm: resume a halted factory",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-resume" },
          run: resume,
        },
        {
          id: "es.status",
          title: "Epistemic Swarm: factory status",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-status" },
          run: status,
        },
        {
          id: "es.lsp.install",
          title: "Epistemic Swarm: install a language server",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-lsp-install", arguments: true },
          run: lspInstall,
        },
      ],
    }))

    const stop = rpc.events.on("changed", (event: any) => toast(`Factory → ${event.data.stage}`))
    return () => stop()
  },
})
