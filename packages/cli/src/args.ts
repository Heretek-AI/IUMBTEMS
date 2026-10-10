// CLI-only argument helpers. The grammar itself (Args, parseArgs, flag,
// BOOLEAN_FLAGS) lives in core (util/args.ts, #97) so the CLI parser and the
// human-only policy cannot drift apart; import it from @heretek-ai/es-core.

/** "7d", "12h", "90m" or an ISO date → Date. */
export function parseExpiry(value: string, now = new Date()): Date {
  const match = /^(\d+)\s*([dhm])$/.exec(value.trim())
  if (match) {
    const n = Number(match[1])
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as "d" | "h" | "m"]
    return new Date(now.getTime() + n * unit)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Cannot parse expiry "${value}" (use 7d, 12h or an ISO date)`)
  return date
}
