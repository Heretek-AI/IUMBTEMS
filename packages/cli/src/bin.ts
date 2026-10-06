#!/usr/bin/env bun
import { FactoryStateMachine, recordApproval, runGates } from "@heretek-ai/es-core"
import { runHeadless } from "./headless.ts"

const args = process.argv.slice(2)
const command = args[0]
const cwd = process.cwd()

async function main() {
  switch (command) {
    case "status": {
      try {
        const machine = await FactoryStateMachine.resume(cwd)
        console.log(JSON.stringify(machine.getState(), null, 2))
      } catch (err: any) {
        console.error("Factory not initialized:", err.message)
        process.exit(1)
      }
      break
    }

    case "init": {
      const ceiling = parseFloat(args[1] ?? "0")
      if (Number.isNaN(ceiling) || ceiling <= 0) {
        console.error("Usage: es-factory init <spendCeilingUSD>")
        process.exit(1)
      }
      const machine = await FactoryStateMachine.init(cwd, ceiling)
      console.log(`Factory initialized with spend ceiling: $${ceiling} USD`)
      console.log(JSON.stringify(machine.getState(), null, 2))
      break
    }

    case "gates": {
      const res = await runGates(cwd)
      console.log(res.summary)
      if (res.findings.length > 0) {
        console.log("\nFindings:")
        for (const f of res.findings) {
          console.log(`- [${f.severity.toUpperCase()}] ${f.file}:${f.line ?? 1} (${f.rule}): ${f.message}`)
          if (f.fixHint) console.log(`  Hint: ${f.fixHint}`)
        }
      }
      process.exit(res.passed ? 0 : 1)
      break
    }

    case "approve": {
      const stage = args[1]
      const artifactPath = args[2]
      const approvedBy = args[3] ?? process.env.USER ?? "human"
      if (!stage || !artifactPath) {
        console.error("Usage: es-factory approve <stage> <artifactPath> [approvedBy]")
        process.exit(1)
      }
      try {
        const record = await recordApproval(cwd, { stage, artifactPath, approvedBy })
        console.log(`Approved ${stage}: ${record.artifactHash.slice(0, 12)}`)
      } catch (err: any) {
        console.error("Approval rejected:", err.message)
        process.exit(1)
      }
      break
    }

    case "run": {
      if (args.includes("--headless")) {
        for await (const event of runHeadless(cwd)) {
          console.log(JSON.stringify(event))
        }
      } else {
        console.error("Interactive CLI run mode coming in M6. Use --headless.")
      }
      break
    }

    default: {
      console.log(`Epistemic Swarm Factory CLI (1.0.0)

Commands:
  status                   Inspect factory state and progress
  init <spendCeilingUSD>   Initialize factory with mandatory spend ceiling
  gates                    Run mechanical verification gates
  approve <stage> <file>   Record authenticated human approval
  run --headless           Run autonomous headless pipeline
`)
      break
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
