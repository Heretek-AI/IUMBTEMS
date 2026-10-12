export const config = {
  apiKey: "hunter2-not-a-real-key-planted-for-fires",
  endpoint: "https://api.example.test",
}

export function debug(log: (line: string) => void) {
  log(`config: ${JSON.stringify(config)}`)
}
