// Epistemic Swarm TUI plugin: previews for the human-only actions. Approvals,
// trust and resume are previewed here, then recorded at a terminal with the
// passphrase-sealed human key (`es approve`, `es trust`, `es factory resume`),
// never through an agent tool or RPC. Only lspInstall still mutates via RPC.
import { userInfo } from "node:os"
import { Plugin } from "@opencode/plugin/tui"
import { registerPanels } from "./panels.tsx"
import { EsRpc } from "./rpc-def.ts"

type Preview = { ok: boolean; title: string; lines: string[]; problems: string[]; token?: string }

export default Plugin.define({
  id: "epistemic-swarm.tui",
  setup(context) {
    const rpc = context.client.rpc(EsRpc) as any
    const location = () => context.location ?? context.data.location.default()
    const call = (method: string, input: unknown = {}) => rpc[method](input, { location: location() })
    const stopPanels = registerPanels(context, call, (listener) => rpc.events.on("changed", () => listener()))
    const user = userInfo().username
    const toast = (message: string, variant: "success" | "error" | "info" = "info") =>
      context.ui.toast.show({ title: "Epistemic Swarm", message, variant })
    // Load warnings (e.g. ignored plugin options) are shown once per TUI start.
    void call("configState")
      .then((view: { warnings: string[] }) => {
        for (const warning of view.warnings) toast(warning, "error")
      })
      .catch(() => undefined)

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
      const preview: Preview = await call("previewApproval", { stage })
      const token = await confirm(preview, "Approve")
      if (!token) return
      await context.ui.dialog.alert({
        title: preview.title,
        message: `${preview.lines.join("\n")}\n\nRun \`es approve ${stage}\` at a terminal with your passphrase (1.1.1: approvals need the sealed human key).`,
      })
    })

    const trust = guarded(async () => {
      const preview: Preview = await call("previewTrust")
      const token = await confirm(preview, "Trust")
      if (!token) return
      await context.ui.dialog.alert({
        title: preview.title,
        message: `${preview.lines.join("\n")}\n\nRun \`es trust\` at a terminal with your passphrase to sign these.`,
      })
    })

    const resume = guarded(async () => {
      const preview: Preview = await call("previewResume")
      const token = await confirm(preview, "Resume")
      if (!token) return
      const lines = preview.lines.join("\n")
      const drift = preview.lines.some((line) => line.startsWith("Control-file drift"))
      // The halt reason names the remedy: a ceiling halt takes a new ceiling,
      // a runtime halt restarts the cap. The values still come from the human.
      let raise = ""
      if (/spend ceiling/i.test(preview.lines[0] ?? "")) {
        const raised = await context.ui.dialog.prompt({ title: "New spend ceiling (USD)", placeholder: "e.g. 50" })
        if (raised) raise = ` --raise-ceiling ${raised}`
      }
      const extend = /runtime cap/i.test(lines) ? " --extend-runtime" : ""
      const flags = `${drift ? " --accept-drift" : ""}${raise}${extend}`
      await context.ui.dialog.alert({
        title: preview.title,
        message: `${preview.lines.join("\n")}\n\nRun \`es factory resume${flags}\` at a terminal with your passphrase.`,
      })
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
        {
          id: "es.panel.factory",
          title: "Epistemic Swarm: factory dashboard",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-factory" },
          run: () => {
            context.ui.panel.open("factory", { presentation: "fullscreen" })
          },
        },
        {
          id: "es.panel.lsp",
          title: "Epistemic Swarm: language server panel",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-lsp-panel" },
          run: () => {
            context.ui.panel.open("lsp", { presentation: "fullscreen" })
          },
        },
        {
          id: "es.panel.hooks",
          title: "Epistemic Swarm: hook inspector",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-hooks" },
          run: () => {
            context.ui.panel.open("hooks", { presentation: "fullscreen" })
          },
        },
        {
          id: "es.panel.brainstorm",
          title: "Epistemic Swarm: brainstorm board",
          group: "Epistemic Swarm",
          palette: true,
          slash: { name: "es-brainstorm" },
          run: () => {
            context.ui.panel.open("brainstorm", { presentation: "fullscreen" })
          },
        },
      ],
    }))

    const stop = rpc.events.on("changed", (event: any) => toast(`Factory → ${event.data.stage}`))
    return () => {
      stopPanels()
      stop()
    }
  },
})
