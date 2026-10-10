// Helper for the S5.2 grant test: awaits the one-time IPC start grant with a
// short timeout. Spawned without an IPC channel (and without a TTY), it must
// exit non-zero. No env var or flag grants it.
import { awaitStartGrant } from "../../src/bin.ts"

await awaitStartGrant(100).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)
