// M0 probe (TUI API): a full-screen session panel opened by a slash command,
// plus a toast. Loaded through the host's runtime Solid transform, so this file
// ships as TSX source and shares the host's solid-js/@opentui instances.
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"

export const PANEL = "es.m0.dashboard"

function Dashboard(props: { sessionID: string }) {
  const context = usePlugin()
  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>ES FACTORY DASHBOARD</text>
      <text>session {props.sessionID}</text>
    </box>
  )
}

export default Plugin.define({
  id: "es.m0.tui-probe",
  setup(context) {
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <Dashboard sessionID={panel.sessionID} />
        </Show>
      ),
    })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "es.m0.factory",
          title: "Open factory dashboard",
          slash: { name: "es-dashboard" },
          run: () => {
            context.ui.panel.open(PANEL, { presentation: "fullscreen" })
          },
        },
      ],
    }))
    context.ui.toast.show({ message: "es tui probe loaded", variant: "success" })
  },
})
