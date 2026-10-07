// Optional OpenAI-compatible embeddings for brainstorm dedupe. Off by default:
// without an `embeddings` config the engine uses MinHash/n-gram similarity, so
// no network call is ever made unless the user opts in.

export interface EmbeddingsConfig {
  /** Endpoint that accepts `{ model, input }` and returns `{ data: [{ embedding }] }`. */
  readonly url: string
  readonly model: string
  /** Environment variable holding the API key, sent as `Authorization: Bearer`. */
  readonly apiKeyEnv?: string
}

/** Cosine similarity of two vectors (0 when either has zero norm). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (!normA || !normB) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface EmbedderOptions {
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
}

/**
 * A batching, caching embedder. Identical texts are embedded once; a response
 * whose vector count does not match the request is an error.
 */
export function createEmbedder(
  config: EmbeddingsConfig,
  options: EmbedderOptions = {},
): (texts: readonly string[]) => Promise<number[][]> {
  const doFetch = options.fetch ?? fetch
  const cache = new Map<string, number[]>()
  return async (texts) => {
    const missing = [...new Set(texts.filter((text) => !cache.has(text)))]
    if (missing.length) {
      const headers: Record<string, string> = { "content-type": "application/json" }
      const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined
      if (key) headers.authorization = `Bearer ${key}`
      const response = await doFetch(config.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, input: missing }),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!response.ok)
        throw new Error(`embeddings request failed: ${response.status} ${await response.text().catch(() => "")}`)
      const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
      const vectors = body.data ?? []
      if (vectors.length !== missing.length)
        throw new Error(`embeddings response has ${vectors.length} vectors for ${missing.length} inputs`)
      missing.forEach((text, index) => {
        cache.set(text, vectors[index]?.embedding ?? [])
      })
    }
    return texts.map((text) => cache.get(text) ?? [])
  }
}
