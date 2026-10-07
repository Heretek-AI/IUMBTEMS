// RPC contract between the server plugin and the TUI. Previews are shown in
// the TUI; human-only mutations (approve, trust, resume) happen at a terminal
// with the passphrase (`es approve`, `es trust`, `es factory resume`), never
// through an agent tool or RPC. Only lspInstall still mutates via RPC.
import { Rpc } from "@opencode/plugin/rpc"

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
})
const str = { type: "string" }
const strArray = { type: "array", items: str }

const Preview = obj({ ok: { type: "boolean" }, title: str, lines: strArray, problems: strArray, token: str }, [
  "ok",
  "title",
  "lines",
  "problems",
])

export const EsRpc = Rpc.define({
  id: "epistemic-swarm",
  methods: {
    status: {
      input: obj({}),
      output: obj({ summary: str, stage: str, pending: strArray }, ["summary", "stage", "pending"]),
    },
    /** The effective config (JSON), the files it came from, and load warnings to show once. */
    configState: {
      input: obj({}),
      output: obj({ config: str, sources: strArray, warnings: strArray }, ["config", "sources", "warnings"]),
    },
    previewApproval: {
      input: obj({ stage: { type: "string", enum: ["frontier", "spec"] } }, ["stage"]),
      output: Preview,
    },
    previewTrust: { input: obj({}), output: Preview },
    previewResume: { input: obj({}), output: Preview },
    previewLspInstall: { input: obj({ id: str }, ["id"]), output: Preview },
    lspInstall: {
      input: obj({ id: str, user: str, token: str }, ["id", "user", "token"]),
      output: obj({ message: str }, ["message"]),
      errors: { refused: obj({ reason: str }, ["reason"]) },
    },
    factoryState: {
      input: obj({}),
      output: obj(
        {
          stage: str,
          runId: str,
          halt: str,
          release: str,
          activePhase: str,
          spend: obj({ usd: { type: "number" }, estimated: { type: "boolean" }, ceilingUSD: { type: "number" } }, [
            "usd",
            "estimated",
          ]),
          phases: { type: "array" },
          pending: strArray,
          audits: { type: "array" },
          tree: obj(
            Object.fromEntries(
              ["round", "total", "settled", "open", "deferred", "facts", "frontier"].map((key) => [
                key,
                { type: "number" },
              ]),
            ),
            ["round", "total", "settled", "open", "deferred", "facts", "frontier"],
          ),
        },
        ["stage", "spend", "phases", "pending"],
      ),
    },
    lspState: {
      input: obj({}),
      output: obj(
        {
          enabled: { type: "boolean" },
          servers: { type: "array" },
          diagnostics: strArray,
        },
        ["enabled", "servers", "diagnostics"],
      ),
    },
    hooksState: {
      input: obj({}),
      output: obj(
        {
          handlers: { type: "number" },
          projectHandlers: { type: "number" },
          trusted: { type: "boolean" },
          projectLines: strArray,
          diagnostics: strArray,
          recent: strArray,
          loss: { type: "array" },
        },
        ["handlers", "projectHandlers", "trusted", "projectLines", "diagnostics", "recent", "loss"],
      ),
    },
    brainstormState: {
      input: obj({}),
      output: obj(
        {
          active: { type: "boolean" },
          brief: str,
          lenses: strArray,
          ideas: { type: "number" },
          duplicates: { type: "number" },
          scored: { type: "number" },
          coverage: { type: "object" },
          shortlist: { type: "array" },
          gaps: strArray,
          complete: { type: "boolean" },
        },
        ["active"],
      ),
    },
  },
  events: {
    changed: { schema: obj({ stage: str, summary: str }, ["stage", "summary"]) },
  },
})
