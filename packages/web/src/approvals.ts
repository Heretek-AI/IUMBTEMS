// Browser approvals UI (#131, ADR 0002 option b): the pending list and the
// approve page. Invariant I1 is structural here: the passphrase is read
// from the masked input into one local `const` at submit time, the input
// is cleared before the request leaves, and nothing — no signal, no
// store, no log line — ever holds it. The preview ticket and CSRF token
// live in the page closure for the same reason.
import { createSignal } from "solid-js"
import type { ApprovePreview, ApproveResult } from "./api.ts"
import { RpcError } from "./api.ts"
import { type Child, h } from "./dom.ts"

export interface PendingPair {
  readonly taskId: string
  readonly reason: string
  readonly stage: string
}

export interface ApprovalsPageProps {
  readonly pending: () => readonly PendingPair[]
  readonly error: () => string | undefined
}

export function ApprovalsPage(props: ApprovalsPageProps): Element {
  return h(
    "main",
    null,
    h("h1", null, "Approvals"),
    () => (props.error() !== undefined ? h("p", { role: "alert" }, `The bus refused the call: ${props.error()}`) : ""),
    () => {
      const pairs = props.pending()
      if (pairs.length === 0) return h("p", null, "Nothing waiting on you.")
      return h(
        "ul",
        null,
        ...pairs.map((pair) =>
          h(
            "li",
            null,
            h("a", { href: `#/approve/${pair.taskId}/${pair.stage}` }, `${pair.taskId} — approve ${pair.stage}`),
            ` — ${pair.reason}`,
          ),
        ),
      )
    },
  )
}

export interface ApprovePageProps {
  readonly taskId: string
  readonly stage: string
  readonly loadPreview: () => Promise<ApprovePreview>
  readonly submit: (ticket: string, csrf: string, passphrase: string) => Promise<ApproveResult>
}

const INPUT_ID = "approve-passphrase"

const shortHash = (hash: string): string => `${hash.slice(0, 16)}…`

const submitErrorEl = (failure: unknown): Element => {
  const message = failure instanceof RpcError ? failure.message : String(failure)
  const details = failure instanceof RpcError ? failure.details : {}
  const extra: Child =
    typeof details.retryAfterSec === "number"
      ? ` Try again in ${details.retryAfterSec}s — the lockout is audited.`
      : typeof details.remaining === "number"
        ? ` ${details.remaining} attempts left before a lockout.`
        : ""
  return h("div", { role: "alert" }, h("p", null, `Not approved: ${message}`), extra === "" ? "" : h("p", null, extra))
}

export function ApprovePage(props: ApprovePageProps): Element {
  const [preview, setPreview] = createSignal<ApprovePreview | undefined>(undefined)
  const [loadError, setLoadError] = createSignal<string | undefined>(undefined)
  const [result, setResult] = createSignal<ApproveResult | undefined>(undefined)
  const [failure, setFailure] = createSignal<unknown>(undefined)
  const [busy, setBusy] = createSignal(false)
  let ticket = ""
  let csrf = ""

  void (async (): Promise<void> => {
    try {
      const seen = await props.loadPreview()
      ticket = seen.ticket
      csrf = seen.csrf
      setPreview(seen)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  })()

  const onApprove = async (): Promise<void> => {
    const input = document.getElementById(INPUT_ID) as HTMLInputElement | null
    // I1: the passphrase lives in this local only; the input is cleared
    // before anything awaits, and no signal ever holds it.
    const passphrase = input?.value ?? ""
    if (input) input.value = ""
    setBusy(true)
    setFailure(undefined)
    try {
      setResult(await props.submit(ticket, csrf, passphrase))
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }

  return h(
    "main",
    null,
    h("p", null, h("a", { href: "#/approvals" }, "← Approvals")),
    h("h1", null, `Approve ${props.stage} on ${props.taskId}`),
    () => {
      const problem = loadError()
      if (problem !== undefined) return h("p", { role: "alert" }, problem)
      const seen = preview()
      if (!seen) return h("p", null, "Loading the preview…")
      return h(
        "div",
        null,
        h("ul", null, ...seen.summary.map((line) => h("li", null, line))),
        h(
          "table",
          null,
          h("thead", null, h("tr", null, h("th", null, "File"), h("th", null, "SHA-256"))),
          h(
            "tbody",
            null,
            ...seen.files.map((file) =>
              h("tr", null, h("td", null, file.path), h("td", null, h("code", null, shortHash(file.sha256)))),
            ),
          ),
        ),
        h(
          "p",
          null,
          `Subject hash ${shortHash(seen.subjectHash)}.`,
          seen.pending
            ? ""
            : " Not currently pending — approving still records, but check why it is not pending first.",
        ),
        h(
          "form",
          {
            onsubmit: (event: Event) => {
              event.preventDefault()
              void onApprove()
            },
          },
          h(
            "p",
            null,
            h("label", { for: INPUT_ID }, "Passphrase "),
            h("input", { id: INPUT_ID, type: "password", autocomplete: "off", "aria-label": "Passphrase" }),
          ),
          h(
            "p",
            null,
            h("button", { type: "button", onclick: () => void onApprove() }, () => (busy() ? "Approving…" : "Approve")),
          ),
        ),
      )
    },
    () => {
      const done = result()
      if (!done) return ""
      return h(
        "section",
        null,
        h("h2", null, "Approved"),
        h(
          "p",
          null,
          `${done.stage} approved in the browser.${done.alreadyApproved ? " (The record already existed and was re-used.)" : ""}`,
        ),
        h("p", null, done.factoryStage ? `Factory stage now ${done.factoryStage}.` : ""),
      )
    },
    () => {
      const problem = failure()
      return problem === undefined ? "" : submitErrorEl(problem)
    },
  )
}
