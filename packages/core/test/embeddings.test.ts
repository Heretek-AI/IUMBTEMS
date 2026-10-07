// The optional OpenAI-compatible embeddings client used by brainstorm dedupe:
// cosine, batching/caching, and an error when the vector count does not match.
import { expect, test } from "bun:test"
import { cosine, createEmbedder } from "../src/index.ts"

const okResponse = (vectors: number[][]) =>
  new Response(JSON.stringify({ data: vectors.map((embedding) => ({ embedding })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

test("cosine is 1 for identical directions, 0 for orthogonal/empty", () => {
  expect(cosine([1, 0], [2, 0])).toBeCloseTo(1)
  expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
  expect(cosine([], [1])).toBe(0)
  expect(cosine([0, 0], [1, 1])).toBe(0)
})

test("createEmbedder batches, caches and sends the bearer key", async () => {
  const requests: Array<{ body: any; auth?: string }> = []
  const fakeFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body)
    requests.push({ body, auth: init.headers.authorization })
    return okResponse(body.input.map((text: string) => [text.length, 1]))
  }) as unknown as typeof fetch

  process.env.ES_TEST_EMBED_KEY = "secret"
  const embed = createEmbedder(
    { url: "https://embed.test/v1", model: "m", apiKeyEnv: "ES_TEST_EMBED_KEY" },
    {
      fetch: fakeFetch,
    },
  )

  const first = await embed(["alpha", "beta"])
  expect(first).toEqual([
    [5, 1],
    [4, 1],
  ])
  expect(requests).toHaveLength(1)
  expect(requests[0]!.body).toEqual({ model: "m", input: ["alpha", "beta"] })
  expect(requests[0]!.auth).toBe("Bearer secret")

  // Cached: a second call for a known text makes no request, and only the new
  // text is sent.
  const second = await embed(["alpha", "gamma!!"])
  expect(second).toEqual([
    [5, 1],
    [7, 1],
  ])
  expect(requests).toHaveLength(2)
  expect(requests[1]!.body.input).toEqual(["gamma!!"])
})

test("createEmbedder throws on a vector-count mismatch", async () => {
  const fakeFetch = (async () => okResponse([[1, 2]])) as unknown as typeof fetch
  const embed = createEmbedder({ url: "https://embed.test/v1", model: "m" }, { fetch: fakeFetch })
  await expect(embed(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/)
})
