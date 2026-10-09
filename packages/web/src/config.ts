// Config editor (#132, preview-only mode): strict-schema validation with
// exact hash diffs and the terminal commands that apply them. There is no
// apply path: no button, no RPC beyond `fleet.config.get`/`fleet.config.plan`
// (the bus refuses `fleet.config.apply`), and applying stays terminal-only
// per ADR 0002 I7 until the user explicitly extends it (after #131). The
// textarea is uncontrolled — Preview reads the live DOM value, so
// in-progress edits are never clobbered by background refetches; switching
// tabs rebuilds the pane from the last fetched view.
import { createSignal } from "solid-js"
import type { ConfigPlan, ConfigView } from "./api.ts"
import { type Child, h } from "./dom.ts"

export interface ConfigEditorProps {
  readonly view: () => ConfigView | undefined
  readonly error: () => string | undefined
  readonly preview: (file: "config" | "gates", content: unknown) => Promise<ConfigPlan>
}

type Pane = "config" | "gates"

const AREA_ID = "config-editor-text"

const pretty = (value: Record<string, unknown> | null): string =>
  value === null ? "{}" : `${JSON.stringify(value, null, 2)}\n`

const shortHash = (hash: string | null): string => (hash === null ? "(absent)" : `${hash.slice(0, 16)}…`)

const copyCommand = async (command: string): Promise<void> => {
  try {
    await navigator.clipboard?.writeText(command)
  } catch {
    // Clipboard needs a secure context and a gesture: the command text
    // stays visible for manual copy when it is unavailable.
  }
}

const planEl = (pane: Pane, plan: ConfigPlan): Element => {
  if (!plan.ok)
    return h(
      "div",
      { role: "alert" },
      h("p", null, "Invalid — fix the errors and preview again:"),
      h("ul", null, ...plan.errors.map((issue) => h("li", null, issue))),
    )
  const hashLine =
    plan.changedKeys.length === 0
      ? h("p", null, `No changes (hash ${shortHash(plan.newHash)}).`)
      : h(
          "div",
          null,
          h(
            "p",
            null,
            `Hash ${shortHash(plan.oldHash)} → ${shortHash(plan.newHash)}, changed keys: ${plan.changedKeys.join(", ")}.`,
          ),
          h("p", null, "Run these in a terminal to apply:"),
          h(
            "ul",
            null,
            ...plan.commands.map((command) =>
              h(
                "li",
                null,
                h("code", null, command),
                " ",
                h("button", { class: "copy", type: "button", onclick: () => void copyCommand(command) }, "Copy"),
              ),
            ),
          ),
        )
  void pane
  return hashLine
}

export function ConfigEditor(props: ConfigEditorProps): Element {
  const [pane, setPane] = createSignal<Pane>("config")
  const [plan, setPlan] = createSignal<ConfigPlan | undefined>(undefined)
  const [localError, setLocalError] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const onPreview = async (): Promise<void> => {
    const area = document.getElementById(AREA_ID) as HTMLTextAreaElement | null
    let content: unknown
    try {
      content = JSON.parse(area?.value ?? "null")
    } catch {
      setPlan(undefined)
      setLocalError("The edited text is not valid JSON.")
      return
    }
    setBusy(true)
    setLocalError(undefined)
    try {
      setPlan(await props.preview(pane(), content))
    } catch (failure) {
      setPlan(undefined)
      setLocalError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const tab = (name: Pane, label: string): Element =>
    h(
      "button",
      {
        type: "button",
        "aria-pressed": String(pane() === name),
        onclick: () => {
          setPane(name)
          setPlan(undefined)
          setLocalError(undefined)
        },
      },
      label,
    )

  return h(
    "main",
    null,
    h("h1", null, "Config"),
    h(
      "p",
      null,
      "Preview-only: edit, validate and diff here; applying happens in a terminal. ",
      "Browser apply needs your explicit ADR 0002 extension (after #131).",
    ),
    () => (props.error() !== undefined ? h("p", { role: "alert" }, `The bus refused the call: ${props.error()}`) : ""),
    () => {
      const seen = props.view()
      if (!seen) return h("p", null, "Loading…")
      const current = pane() === "config" ? seen.config : seen.gates
      const drift: Child = seen.drift.clean
        ? ""
        : h(
            "section",
            null,
            h("h2", null, "Drift warning"),
            h("p", null, "Control files changed outside a human action — run es rebaseline after applying:"),
            h("ul", null, ...seen.drift.violations.map((violation) => h("li", null, violation))),
          )
      return h(
        "div",
        null,
        h("div", { role: "tablist" }, tab("config", "Project config"), tab("gates", "Gates")),
        drift,
        h("h2", null, pane() === "config" ? "Project config (.factory/config.json)" : "Gates (.factory/gates.json)"),
        h("p", null, `Current hash ${shortHash(pane() === "config" ? seen.configHash : seen.gatesHash)}.`),
        h("pre", null, pretty(current)),
        h("p", null, "Edit below, then preview the exact diff and commands:"),
        h("textarea", { id: AREA_ID, rows: "14", cols: "72" }, pretty(current)),
        h(
          "p",
          null,
          h("button", { type: "button", onclick: () => void onPreview() }, () => (busy() ? "Previewing…" : "Preview")),
        ),
        () => {
          const failure = localError()
          if (failure !== undefined) return h("p", { role: "alert" }, failure)
          const done = plan()
          return done ? planEl(pane(), done) : ""
        },
      )
    },
  )
}
