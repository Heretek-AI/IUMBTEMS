import { FactoryStateMachine, recordApproval, runGates } from "@heretek-ai/es-core"

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "factory_status",
    description: "Get current status of the AI build factory",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "factory_init",
    description: "Initialize factory pipeline with spend ceiling",
    inputSchema: {
      type: "object",
      properties: { spendCeilingUSD: { type: "number" } },
      required: ["spendCeilingUSD"],
    },
  },
  {
    name: "factory_advance",
    description: "Advance factory stage",
    inputSchema: {
      type: "object",
      properties: {
        qa_a_passed: { type: "boolean" },
        qa_b_passed: { type: "boolean" },
      },
    },
  },
  {
    name: "gates_run",
    description: "Run mechanical verification gates",
    inputSchema: {
      type: "object",
      properties: { touchedFiles: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "approve",
    description: "Record human approval for factory transition",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string" },
        phaseId: { type: "string" },
        artifactPath: { type: "string" },
        approvedBy: { type: "string" },
      },
      required: ["stage", "artifactPath", "approvedBy"],
    },
  },
]

export async function executeMcpTool(rootDir: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "factory_status": {
      const machine = await FactoryStateMachine.resume(rootDir)
      return machine.getState()
    }
    case "factory_init": {
      const ceiling = Number(args.spendCeilingUSD)
      const machine = await FactoryStateMachine.init(rootDir, ceiling)
      return machine.getState()
    }
    case "factory_advance": {
      const machine = await FactoryStateMachine.resume(rootDir)
      return machine.advance({
        qa_a_passed: Boolean(args.qa_a_passed),
        qa_b_passed: Boolean(args.qa_b_passed),
      })
    }
    case "gates_run": {
      const touched = Array.isArray(args.touchedFiles) ? (args.touchedFiles as string[]) : []
      return runGates(rootDir, { touchedFiles: touched })
    }
    case "approve": {
      return recordApproval(rootDir, {
        stage: String(args.stage),
        phaseId: args.phaseId ? String(args.phaseId) : undefined,
        artifactPath: String(args.artifactPath),
        approvedBy: String(args.approvedBy),
      })
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
