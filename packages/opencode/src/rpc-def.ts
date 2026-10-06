// RPC contract between the server plugin and the TUI. These methods are the
// TUI half of the human-only channel: no agent tool reaches them, and the TUI
// only calls them after a human confirms a dialog showing what is approved.
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
    previewApproval: {
      input: obj({ stage: { type: "string", enum: ["frontier", "spec"] } }, ["stage"]),
      output: Preview,
    },
    approve: {
      input: obj({ stage: { type: "string", enum: ["frontier", "spec"] }, user: str, token: str }, [
        "stage",
        "user",
        "token",
      ]),
      output: obj({ message: str }, ["message"]),
      errors: { refused: obj({ reason: str }, ["reason"]) },
    },
    previewTrust: { input: obj({}), output: Preview },
    trust: {
      input: obj({ user: str, token: str }, ["user", "token"]),
      output: obj({ message: str }, ["message"]),
      errors: { refused: obj({ reason: str }, ["reason"]) },
    },
    previewResume: { input: obj({}), output: Preview },
    previewLspInstall: { input: obj({ id: str }, ["id"]), output: Preview },
    lspInstall: {
      input: obj({ id: str, user: str, token: str }, ["id", "user", "token"]),
      output: obj({ message: str }, ["message"]),
      errors: { refused: obj({ reason: str }, ["reason"]) },
    },
    resume: {
      input: obj(
        {
          user: str,
          token: str,
          acceptControlDrift: { type: "boolean" },
          raiseCeilingUSD: { type: "number" },
          extendRuntime: { type: "boolean" },
        },
        ["user", "token"],
      ),
      output: obj({ message: str }, ["message"]),
      errors: { refused: obj({ reason: str }, ["reason"]) },
    },
  },
  events: {
    changed: { schema: obj({ stage: str, summary: str }, ["stage", "summary"]) },
  },
})
