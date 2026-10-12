// Config editor (#132 preview, #145 browser apply for project config):
// strict-schema validation with exact hash diffs and the terminal commands
// that apply them. Project-config edits may additionally be applied in the
// browser (ADR 0002 I7 narrow): after a successful preview the editor
// offers a masked passphrase input + Apply that submits exactly the
// previewed content through the ticketed path. Gates panes never offer it
// (terminal-only), and without the apply hooks the editor stays
// preview-only. The textarea is uncontrolled — Preview reads the live DOM
// value, so in-progress edits are never clobbered by background refetches;
// switching tabs rebuilds the pane from the last fetched view. Invariant
// I1 is structural: the passphrase is read from the masked input into one
// local `const` at submit time, the input is cleared before the request
// leaves, and nothing — no signal, no store, no log line — ever holds it.
// The preview ticket, CSRF token and previewed content live in the page
// closure for the same reason.
import { createSignal } from "solid-js"
import type { ConfigPlan, ConfigView } from "./api.ts"
import { type Child, h } from "./dom.ts"

export interface ConfigApplyTicket {
  readonly ticket: string
  readonly csrf: string
  readonly newHash: string
}

export interface ConfigApplyResult {
  readonly ok: boolean
  readonly newHash: string
}

export interface ConfigEditorProps {
  readonly view: () => ConfigView | undefined
  readonly error: () => string | undefined
  readonly preview: (file: "config" | "gates", content: unknown) => Promise<ConfigPlan>
  /** Browser-apply path (#145): absent keeps the editor preview-only. */
  readonly requestTicket?: (file: "config" | "gates", content: unknown) => Promise<ConfigApplyTicket>
  readonly submitApply?: (
    ticket: string,
    csrf: string,
    passphrase: string,
    file: "config" | "gates",
    content: unknown,
  ) => Promise<ConfigApplyResult>
}

type Pane = "config" | "gates"

const AREA_ID = "config-editor-text"
const APPLY_INPUT_ID = "config-apply-passphrase"

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
  const [applyBusy, setApplyBusy] = createSignal(false)
  const [applyReady, setApplyReady] = createSignal(false)
  const [applyDone, setApplyDone] = createSignal<ConfigApplyResult | undefined>(undefined)
  const [applyFailure, setApplyFailure] = createSignal<unknown>(undefined)
  // Apply closure (#145, I1/I3): the ticket, CSRF token and the exact
  // previewed content snapshot. Kept out of signals so reactive snapshots
  // and logs can never carry them; the passphrase never lands here at all.
  let applyTicket = ""
  let applyCsrf = ""
  let applyContent: unknown
  let applyNewHash = ""

  const resetApply = (): void => {
    applyTicket = ""
    applyCsrf = ""
    applyContent = undefined
    applyNewHash = ""
    setApplyReady(false)
    setApplyDone(undefined)
    setApplyFailure(undefined)
  }

  const onPreview = async (): Promise<void> => {
    const area = document.getElementById(AREA_ID) as HTMLTextAreaElement | null
    let content: unknown
    try {
      content = JSON.parse(area?.value ?? "null")
    } catch {
      setPlan(undefined)
      resetApply()
      setLocalError("The edited text is not valid JSON.")
      return
    }
    setBusy(true)
    setLocalError(undefined)
    resetApply()
    try {
      const seen = await props.preview(pane(), content)
      setPlan(seen)
      // Browser apply (#145, project config only): bind the previewed
      // content snapshot to a single-use ticket. Gates panes and hook-less
      // shells stay terminal-only.
      if (pane() === "config" && seen.ok && seen.changedKeys.length > 0 && props.requestTicket && props.submitApply) {
        try {
          const issued = await props.requestTicket("config", content)
          applyTicket = issued.ticket
          applyCsrf = issued.csrf
          applyContent = content
          applyNewHash = issued.newHash
          setApplyReady(true)
        } catch (failure) {
          setApplyFailure(failure)
        }
      }
    } catch (failure) {
      setPlan(undefined)
      setLocalError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const onApply = async (): Promise<void> => {
    if (!props.submitApply || !applyReady()) return
    const input = document.getElementById(APPLY_INPUT_ID) as HTMLInputElement | null
    // I1: the passphrase lives in this local only; the input is cleared
    // before anything awaits, and no signal ever holds it.
    const passphrase = input?.value ?? ""
    if (input) input.value = ""
    // Submit exactly the previewed snapshot — never re-read the textarea,
    // so edits made after the preview cannot smuggle in unreviewed bytes.
    const ticket = applyTicket
    const csrf = applyCsrf
    const content = applyContent
    setApplyBusy(true)
    setApplyFailure(undefined)
    try {
      setApplyDone(await props.submitApply(ticket, csrf, passphrase, "config", content))
      setApplyReady(false)
    } catch (error) {
      setApplyFailure(error)
    } finally {
      setApplyBusy(false)
    }
  }

  const applyErrorEl = (failure: unknown): Element => {
    const message = failure instanceof Error ? failure.message : String(failure)
    const details = (failure as { details?: Record<string, unknown> } | null)?.details ?? {}
    const extra: Child =
      typeof details.retryAfterSec === "number"
        ? ` Try again in ${details.retryAfterSec}s — the lockout is audited.`
        : typeof details.remaining === "number"
          ? ` ${details.remaining} attempts left before a lockout.`
          : ""
    return h("div", { role: "alert" }, h("p", null, `Not applied: ${message}`), extra === "" ? "" : h("p", null, extra))
  }

  const applySection = (): Child => {
    if (pane() !== "config" || !props.requestTicket || !props.submitApply) return ""
    const done = applyDone()
    if (done)
      return h(
        "section",
        null,
        h("h2", null, "Applied"),
        h("p", null, `Applied in the browser (hash ${shortHash(done.newHash)}). The bytes on disk equal the preview.`),
      )
    if (!applyReady()) return ""
    const failure = applyFailure()
    return h(
      "section",
      null,
      h("h2", null, "Apply in the browser"),
      h("p", null, `This submits exactly the previewed edit (hash ${shortHash(applyNewHash)}).`),
      h(
        "p",
        null,
        h("label", { for: APPLY_INPUT_ID }, "Passphrase "),
        h("input", { id: APPLY_INPUT_ID, type: "password", autocomplete: "off", "aria-label": "Passphrase" }),
      ),
      h(
        "p",
        null,
        h("button", { type: "button", onclick: () => void onApply() }, () =>
          applyBusy() ? "Applying…" : "Apply in browser",
        ),
      ),
      failure === undefined ? "" : applyErrorEl(failure),
    )
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
          resetApply()
        },
      },
      label,
    )

  const canApply = props.requestTicket !== undefined && props.submitApply !== undefined

  return h(
    "main",
    null,
    h("h1", null, "Config"),
    canApply
      ? h(
          "p",
          null,
          "Project config edits can be applied here with your passphrase after previewing; ",
          "gates edits stay terminal-only (run them in a terminal with es rebaseline).",
        )
      : h(
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
        pane() === "gates" && canApply
          ? h("p", null, "Gates edits stay terminal-only: save the previewed JSON and run es rebaseline in a terminal.")
          : "",
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
        () => applySection(),
        () => {
          // A ticket/request failure with no preview plan still surfaces.
          if (plan() !== undefined || applyReady() || applyDone() !== undefined) return ""
          const failure = applyFailure()
          return failure === undefined ? "" : applyErrorEl(failure)
        },
      )
    },
  )
}
