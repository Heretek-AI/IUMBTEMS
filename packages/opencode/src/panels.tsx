// The four TUI panels: factory dashboard, LSP manager, hook inspector and
// brainstorm board, plus the prompt-footer liveness indicator. Each panel is a
// session.panel slot contribution (the host renders the one whose name is
// open) and reads structured state from the server plugin over RPC — the same
// human-only channel the dialogs use. While open, a panel refetches on every
// server `changed` event and every couple of seconds, so it follows a running
// factory. The host gives panels no key bindings of their own (#57): each
// panel binds Esc/q (close), f (fullscreen) and r (refresh) through a keymap
// layer created inside it, which the host scopes to the panel's focus, and
// shows them in a footer row.
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"

export type PanelCall = (method: string, input?: unknown) => Promise<any>
/** Subscribe to server state changes; returns the unsubscribe function. */
export type PanelSubscribe = (listener: () => void) => () => void

/** The host's session.panel slot input (the parts a panel uses). */
export interface PanelHandle {
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

interface PanelKeyCommand {
  readonly title: string
  readonly bind: string
  readonly run: () => void
}
/** The host's keymap.layer: a layer created during render belongs to that panel's focus scope. */
export type PanelLayer = (factory: () => { readonly commands: readonly PanelKeyCommand[] }) => void

export interface PanelProps {
  readonly call: PanelCall
  readonly subscribe: PanelSubscribe
  readonly panel?: PanelHandle
  readonly layer?: PanelLayer
}

export const PANEL_REFRESH_MS = 2_000
export const FOOTER_REFRESH_MS = 5_000

/** Panel data, refetched on change events, on an interval while mounted, and on demand. */
function usePanelState(
  props: PanelProps,
  method: string,
  everyMs = PANEL_REFRESH_MS,
): { data: () => any; error: () => string | undefined; refresh: () => void } {
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((value) => value + 1)
  const unsubscribe = props.subscribe(bump)
  const timer = setInterval(bump, everyMs)
  onCleanup(() => {
    unsubscribe()
    clearInterval(timer)
  })
  const [state] = createResource(
    version,
    (): Promise<{ data?: any; error?: string }> =>
      props.call(method).then(
        (data) => ({ data }),
        (error: any) => ({ error: String(error?.data?.reason ?? error?.message ?? error) }),
      ),
  )
  return { data: () => state.latest?.data, error: () => state.latest?.error, refresh: bump }
}

/** The panel's keys: Esc or q closes it, f toggles fullscreen, r refetches. */
export const PANEL_KEYS_HINT = "esc/q close · f fullscreen · r refresh"

function usePanelKeys(props: PanelProps, refresh: () => void) {
  const panel = props.panel
  if (!panel || !props.layer) return
  props.layer(() => ({
    commands: [
      { title: "close", bind: "escape,q", run: () => panel.close() },
      { title: "fullscreen", bind: "f", run: () => panel.toggleFullscreen() },
      { title: "refresh", bind: "r", run: refresh },
    ],
  }))
}

const Frame = (props: { title: string; children?: any }) => (
  <box flexDirection="column" padding={1} gap={1}>
    <text>{props.title}</text>
    {props.children}
    <text>{PANEL_KEYS_HINT}</text>
  </box>
)

const Failed = (props: { error: () => string | undefined }) => (
  <Show when={props.error()}>
    <text>Could not load: {props.error()}</text>
  </Show>
)

const FactoryPanel = (props: PanelProps) => {
  const state = usePanelState(props, "factoryState")
  usePanelKeys(props, state.refresh)
  return (
    <Frame title="Factory dashboard">
      <Failed error={state.error} />
      <Show when={state.data()} fallback={<text>{state.error() ? "" : "Loading factory state…"}</text>}>
        {(data: () => any) => (
          <>
            <text>{data().headline}</text>
            <Show when={data().header} fallback={<text>Stage: {data().stage}</text>}>
              <text>{data().header}</text>
            </Show>
            <Show when={data().stage !== "NONE"}>
              <text>
                Spend: ${data().spend.usd.toFixed(2)}
                {data().spend.ceilingUSD ? ` / $${data().spend.ceilingUSD}` : ""}
                {data().spend.estimated ? " (estimated)" : ""}
              </text>
            </Show>
            <Show when={data().tree}>
              <text>
                Design tree (round {data().tree.round}): {data().tree.settled} settled · {data().tree.open} open ·{" "}
                {data().tree.deferred} deferred
                {data().tree.facts ? ` (${data().tree.facts} for research)` : ""}
              </text>
            </Show>
            <Show when={data().paused}>
              <text>⏸ {data().paused}</text>
            </Show>
            <Show when={data().halt}>
              <text>HALTED: {data().halt}</text>
            </Show>
            <Show when={data().pending.length}>
              <text>
                Waiting on you: approve {data().pending.join(", ")} with /es-approve (or `es approve {data().pending[0]}
                `)
              </text>
            </Show>
            <Show when={data().seats.length}>
              <box flexDirection="column">
                <text>Seats:</text>
                <For each={data().seats}>{(line: string) => <text>{`  ${line}`}</text>}</For>
              </box>
            </Show>
            <Show when={data().research}>
              <text>Research: {data().research}</text>
            </Show>
            <Show when={data().phases.length}>
              <box flexDirection="column">
                <text>Phases:</text>
                <For each={data().phases}>
                  {(phase: any) => (
                    <text>
                      {phase.id === data().activePhase ? "▶ " : "  "}
                      {phase.id}
                      {phase.title ? ` ${phase.title}` : ""} · {phase.status} · failures {phase.failures}
                    </text>
                  )}
                </For>
              </box>
            </Show>
            <Show when={data().audits?.length}>
              <box flexDirection="column">
                <text>Audits:</text>
                <For each={data().audits}>
                  {(audit: any) => (
                    <text>
                      {"  "}
                      {audit.id} · {audit.target} · {audit.status} r{audit.round} · t:{audit.thesis} a:
                      {audit.antithesis}
                      {audit.tiebreak ? ` x:${audit.tiebreak}` : ""}
                    </text>
                  )}
                </For>
              </box>
            </Show>
            <Show when={data().events.length}>
              <box flexDirection="column">
                <text>Recent events:</text>
                <For each={data().events}>{(line: string) => <text>{`  ${line}`}</text>}</For>
              </box>
            </Show>
            <Show when={data().release}>
              <text>PR: {data().release}</text>
            </Show>
          </>
        )}
      </Show>
    </Frame>
  )
}

const LspPanel = (props: PanelProps) => {
  const state = usePanelState(props, "lspState")
  usePanelKeys(props, state.refresh)
  return (
    <Frame title="Language servers">
      <Failed error={state.error} />
      <Show when={state.data()} fallback={<text>{state.error() ? "" : "Loading language servers…"}</text>}>
        {(data: () => any) => (
          <>
            <text>{data().enabled ? "LSP is on." : "LSP is disabled (lsp: false)."}</text>
            <For each={data().servers}>
              {(server: any) => (
                <text>
                  {server.available ? "●" : "○"} {server.id} [{server.extensions.join(" ")}]
                  {server.running ? ` · ${server.running} running` : ""}
                  {server.available ? "" : " — not installed"}
                </text>
              )}
            </For>
            <For each={data().diagnostics}>{(diagnostic: string) => <text>! {diagnostic}</text>}</For>
          </>
        )}
      </Show>
    </Frame>
  )
}

const HooksPanel = (props: PanelProps) => {
  const state = usePanelState(props, "hooksState")
  usePanelKeys(props, state.refresh)
  return (
    <Frame title="Hook bridge">
      <Failed error={state.error} />
      <Show when={state.data()} fallback={<text>{state.error() ? "" : "Loading hooks…"}</text>}>
        {(data: () => any) => (
          <>
            <text>
              {data().handlers} handler(s) · {data().projectHandlers} from the project ·{" "}
              {data().projectHandlers === 0 ? "nothing to trust" : data().trusted ? "trusted" : "NOT trusted"}
            </text>
            <For each={data().projectLines}>{(line: string) => <text>{line}</text>}</For>
            <Show when={data().loss.length}>
              <text>Capability loss (advisory rows):</text>
              <For each={data().loss}>
                {(item: any) => (
                  <text>
                    ! {item.event} · {item.handler} — {item.support}: {item.reason}
                  </text>
                )}
              </For>
            </Show>
            <For each={data().diagnostics}>{(item: string) => <text>! {item}</text>}</For>
            <For each={data().recent}>{(item: string) => <text>recent error: {item}</text>}</For>
          </>
        )}
      </Show>
    </Frame>
  )
}

const BrainstormPanel = (props: PanelProps) => {
  const state = usePanelState(props, "brainstormState")
  usePanelKeys(props, state.refresh)
  return (
    <Frame title="Brainstorm board">
      <Failed error={state.error} />
      <Show when={state.data()} fallback={<text>{state.error() ? "" : "Loading brainstorm…"}</text>}>
        {(data: () => any) => (
          <Show when={data().active} fallback={<text>No brainstorm in .factory/brainstorm yet. Run /brainstorm.</text>}>
            <text>Brief: {data().brief}</text>
            <Show when={data().runs?.length > 1}>
              <text>
                Run {data().run} ({data().runs.length} runs: {data().runs.join(", ")} — `es brainstorm show [run]`)
              </text>
            </Show>
            <text>
              {data().ideas} idea(s) · {data().duplicates} duplicate(s) · {data().scored} scored ·{" "}
              {data().complete ? "complete" : "in progress"}
            </text>
            <text>
              Coverage:{" "}
              {data()
                .lenses.map((lens: string) => `${lens} ${data().coverage[lens] ?? 0}`)
                .join(" · ")}
            </text>
            <Show when={data().gaps.length}>
              <text>Gaps: {data().gaps.join(", ")}</text>
            </Show>
            <Show when={data().shortlist.length}>
              <text>Shortlist:</text>
              <For each={data().shortlist}>
                {(entry: any) => (
                  <text>
                    {entry.outlier ? "◇" : "◆"} {entry.id} ({entry.total}/20) — {entry.title}
                    {entry.outlier ? " (forced outlier)" : ""}
                  </text>
                )}
              </For>
            </Show>
          </Show>
        )}
      </Show>
    </Frame>
  )
}

/** The panel components by panel name (rendered headlessly in tests). */
export const PANEL_COMPONENTS: Readonly<Record<string, (props: PanelProps) => any>> = {
  factory: FactoryPanel,
  lsp: LspPanel,
  hooks: HooksPanel,
  brainstorm: BrainstormPanel,
}

/** The prompt-footer liveness indicator: "ES · RESEARCH · es-research-alpha running · 12s"; hidden without a run. */
export const FactoryFooter = (props: PanelProps) => {
  const state = usePanelState(props, "status", FOOTER_REFRESH_MS)
  return (
    <Show when={state.data()?.footer}>
      <text>{state.data().footer}</text>
    </Show>
  )
}

/**
 * Claim a slot. The entry point moved across host releases: opencode 2.0.x
 * exposes it as context.ui.slot (arity 1 object form or arity 2 name/render
 * form), later hosts as bare context.slot. Without either the slot stays
 * unclaimed, but setup must not throw (commands keep working).
 */
function claimSlot(context: any, name: string, render: (input: any) => any): (() => void) | undefined {
  const slotFn = typeof context.slot === "function" ? context.slot : context.ui?.slot
  if (typeof slotFn !== "function") return undefined
  const dispose = slotFn.length <= 1 ? slotFn({ append: name, render }) : slotFn(name, render)
  return typeof dispose === "function" ? dispose : undefined
}

/** Claim the session.panel slot once per panel (each claim filters by name), and the footer indicator. */
export function registerPanels(context: any, call: PanelCall, subscribe: PanelSubscribe): () => void {
  const layer: PanelLayer | undefined =
    typeof context.keymap?.layer === "function" ? (factory) => context.keymap.layer(factory) : undefined
  const disposers: Array<() => void> = []
  for (const [name, Panel] of Object.entries(PANEL_COMPONENTS)) {
    const dispose = claimSlot(context, "session.panel", (input: { name: string } & Partial<PanelHandle>) =>
      input.name === name ? (
        <Panel
          call={call}
          subscribe={subscribe}
          {...(input.close && input.toggleFullscreen
            ? { panel: { close: input.close, toggleFullscreen: input.toggleFullscreen } }
            : {})}
          {...(layer ? { layer } : {})}
        />
      ) : null,
    )
    if (dispose) disposers.push(dispose)
  }
  const footer = claimSlot(context, "prompt.footer.status", () => <FactoryFooter call={call} subscribe={subscribe} />)
  if (footer) disposers.push(footer)
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export const PANEL_NAMES = Object.keys(PANEL_COMPONENTS)
