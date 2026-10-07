export const config = {
  apiKey: "hunter2-not-a-real-key-planted-for-fires",  // NOSONAR: planted for audit-fires, not a credential
  endpoint: "https://api.example.test",
}

export function debug(log: (line: string) => void) {
  log(`config: ${JSON.stringify(config)}`)
}
