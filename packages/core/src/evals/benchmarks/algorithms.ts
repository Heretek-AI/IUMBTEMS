// Algorithm instances (#171): searching, sorting, graphs, DP, data structures.
import type { BenchmarkCase } from "../benchmarks.ts"
import { C, stub } from "./shared.ts"

export const ALGORITHMS: readonly BenchmarkCase[] = [
  C(
    "algo-01-binary-search",
    "algorithms",
    1,
    "Binary-search a sorted array, returning the index or -1.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function search(nums: number[], target: number): number {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "search", args: [[1, 3, 5, 7], 5], expected: 2 },
        { fn: "search", args: [[1, 3, 5, 7], 4], expected: -1 },
        { fn: "search", args: [[], 1], expected: -1 },
        { fn: "search", args: [[2], 2], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function search(nums: number[], target: number): number {\n  let lo = 0\n  let hi = nums.length - 1\n  while (lo <= hi) {\n    const mid = (lo + hi) >> 1\n    if (nums[mid] === target) return mid\n    if (nums[mid]! < target) lo = mid + 1\n    else hi = mid - 1\n  }\n  return -1\n}\n",
    },
  ),
  C(
    "algo-02-quicksort",
    "algorithms",
    2,
    "Return a sorted copy of the input without mutating it.",
    "src/solution.ts",
    { "src/solution.ts": 'export function sortNums(nums: number[]): number[] {\n  throw new Error("stub")\n}\n' },
    {
      properties: [
        { fn: "sortNums", args: [[3, 1, 2]], expected: [1, 2, 3] },
        { fn: "sortNums", args: [[5, 5, 1, 0, -2]], expected: [-2, 0, 1, 5, 5] },
        { fn: "sortNums", args: [[]], expected: [] },
      ],
      mustNotContain: ["throw"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function sortNums(nums: number[]): number[] {\n  if (nums.length < 2) return [...nums]\n  const [pivot, ...rest] = nums as [number, ...number[]]\n  return [...sortNums(rest.filter((x) => x < pivot!)), pivot!, ...sortNums(rest.filter((x) => x >= pivot!))]\n}\n",
    },
  ),
  C(
    "algo-03-merge-intervals",
    "algorithms",
    2,
    "Merge overlapping [start, end] intervals; the classic last-interval bug is planted in the seed.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function merge(intervals: number[][]): number[][] {\n  if (!intervals.length) return []\n  const sorted = [...intervals].sort((a, b) => a[0]! - b[0]!)\n  const out: number[][] = [sorted[0]!]\n  for (const [s, e] of sorted.slice(1)) {\n    const last = out[out.length - 1]!\n    if (s! <= last[1]!) last[1] = Math.max(last[1]!, e!)\n    else out.push([s!, e!])\n  }\n  return out.slice(0, -1)\n}\n",
    },
    {
      properties: [
        {
          fn: "merge",
          args: [
            [
              [1, 3],
              [2, 6],
              [8, 10],
              [15, 18],
            ],
          ],
          expected: [
            [1, 6],
            [8, 10],
            [15, 18],
          ],
        },
        {
          fn: "merge",
          args: [
            [
              [1, 4],
              [4, 5],
            ],
          ],
          expected: [[1, 5]],
        },
        { fn: "merge", args: [[]], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function merge(intervals: number[][]): number[][] {\n  if (!intervals.length) return []\n  const sorted = [...intervals].sort((a, b) => a[0]! - b[0]!)\n  const out: number[][] = [sorted[0]!]\n  for (const [s, e] of sorted.slice(1)) {\n    const last = out[out.length - 1]!\n    if (s! <= last[1]!) last[1] = Math.max(last[1]!, e!)\n    else out.push([s!, e!])\n  }\n  return out\n}\n",
    },
  ),
  C(
    "algo-04-bfs-path",
    "algorithms",
    2,
    "BFS shortest-path length in an unweighted graph; -1 when unreachable.",
    "src/solution.ts",
    { "src/solution.ts": stub("shortestPath") },
    {
      properties: [
        { fn: "shortestPath", args: [{ a: ["b", "c"], b: ["d"], c: ["d"], d: [] }, "a", "d"], expected: 2 },
        { fn: "shortestPath", args: [{ a: ["b"], b: [] }, "a", "a"], expected: 0 },
        { fn: "shortestPath", args: [{ a: [], b: [] }, "a", "b"], expected: -1 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function shortestPath(graph: Record<string, string[]>, from: string, to: string): number {\n  if (from === to) return 0\n  const seen = new Set([from])\n  let frontier = [from]\n  let depth = 0\n  while (frontier.length) {\n    depth++\n    const next: string[] = []\n    for (const node of frontier)\n      for (const edge of graph[node] ?? []) {\n        if (edge === to) return depth\n        if (!seen.has(edge)) {\n          seen.add(edge)\n          next.push(edge)\n        }\n      }\n    frontier = next\n  }\n  return -1\n}\n",
    },
  ),
  C(
    "algo-05-lru-cache",
    "algorithms",
    3,
    "Simulate an LRU cache over get/put op scripts, returning get results.",
    "src/solution.ts",
    { "src/solution.ts": stub("simulate") },
    {
      properties: [
        {
          fn: "simulate",
          args: [
            2,
            [
              ["put", 1, 1],
              ["put", 2, 2],
              ["get", 1],
              ["put", 3, 3],
              ["get", 2],
              ["get", 3],
            ],
          ],
          expected: [1, -1, 3],
        },
        {
          fn: "simulate",
          args: [
            1,
            [
              ["put", 1, 1],
              ["put", 2, 2],
              ["get", 1],
            ],
          ],
          expected: [-1],
        },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function simulate(capacity: number, ops: Array<['put', number, number] | ['get', number]>): number[] {\n  const cache = new Map<number, number>()\n  const out: number[] = []\n  for (const op of ops) {\n    if (op[0] === 'get') {\n      const value = cache.get(op[1])\n      if (value === undefined) out.push(-1)\n      else {\n        cache.delete(op[1])\n        cache.set(op[1], value)\n        out.push(value)\n      }\n    } else {\n      cache.delete(op[1])\n      cache.set(op[1], op[2])\n      if (cache.size > capacity) cache.delete(cache.keys().next().value!)\n    }\n  }\n  return out\n}\n",
    },
  ),
  C(
    "algo-06-edit-distance",
    "algorithms",
    2,
    "Levenshtein edit distance between two strings.",
    "src/solution.ts",
    { "src/solution.ts": stub("distance") },
    {
      properties: [
        { fn: "distance", args: ["kitten", "sitting"], expected: 3 },
        { fn: "distance", args: ["", "abc"], expected: 3 },
        { fn: "distance", args: ["same", "same"], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function distance(a: string, b: string): number {\n  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[])\n  for (let j = 1; j <= b.length; j++) dp[0]![j] = j\n  for (let i = 1; i <= a.length; i++)\n    for (let j = 1; j <= b.length; j++)\n      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))\n  return dp[a.length]![b.length]!\n}\n",
    },
  ),
  C(
    "algo-07-toposort",
    "algorithms",
    2,
    "Topological order with deterministic lexicographic tie-breaking.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function topoSort(nodes: string[], edges: Array<[string, string]>): string[] {\n  return [...nodes]\n}\n",
    },
    {
      properties: [
        {
          fn: "topoSort",
          args: [
            ["d", "c", "b", "a"],
            [
              ["a", "b"],
              ["b", "c"],
            ],
          ],
          expected: ["a", "b", "c", "d"],
        },
        { fn: "topoSort", args: [["b", "a"], []], expected: ["a", "b"] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function topoSort(nodes: string[], edges: Array<[string, string]>): string[] {\n  const indegree = new Map(nodes.map((n) => [n, 0]))\n  const outgoing = new Map(nodes.map((n) => [n, [] as string[]]))\n  for (const [from, to] of edges) {\n    outgoing.get(from)!.push(to)\n    indegree.set(to, indegree.get(to)! + 1)\n  }\n  const ready = [...nodes].filter((n) => indegree.get(n) === 0).sort()\n  const order: string[] = []\n  while (ready.length) {\n    const node = ready.shift()!\n    order.push(node)\n    for (const next of outgoing.get(node)!) {\n      indegree.set(next, indegree.get(next)! - 1)\n      if (indegree.get(next) === 0) ready.push(next)\n    }\n    ready.sort()\n  }\n  return order\n}\n",
    },
  ),
  C(
    "algo-08-token-bucket",
    "algorithms",
    3,
    "Pure token-bucket admission over a script of request timestamps.",
    "src/solution.ts",
    { "src/solution.ts": stub("admit") },
    {
      properties: [
        { fn: "admit", args: [[0, 0.5, 1, 1.5, 2], 2, 1], expected: [true, true, true, false, true] },
        { fn: "admit", args: [[0, 10], 1, 1], expected: [true, true] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function admit(times: number[], capacity: number, refillPerSec: number): boolean[] {\n  let tokens = capacity\n  let last = times[0] ?? 0\n  return times.map((t) => {\n    tokens = Math.min(capacity, tokens + (t - last) * refillPerSec)\n    last = t\n    if (tokens >= 1) {\n      tokens -= 1\n      return true\n    }\n    return false\n  })\n}\n",
    },
  ),
  C(
    "algo-09-k-largest",
    "algorithms",
    1,
    "Top-k largest values in descending order.",
    "src/solution.ts",
    { "src/solution.ts": stub("kLargest") },
    {
      properties: [
        { fn: "kLargest", args: [[4, 1, 7, 3], 2], expected: [7, 4] },
        { fn: "kLargest", args: [[1], 5], expected: [1] },
        { fn: "kLargest", args: [[], 3], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function kLargest(nums: number[], k: number): number[] {\n  return [...nums].sort((a, b) => b - a).slice(0, Math.max(0, k))\n}\n",
    },
  ),
  C(
    "algo-10-longest-unique-substring",
    "algorithms",
    2,
    "Length of the longest substring without repeating characters.",
    "src/solution.ts",
    { "src/solution.ts": stub("longestUnique") },
    {
      properties: [
        { fn: "longestUnique", args: ["abcabcbb"], expected: 3 },
        { fn: "longestUnique", args: ["bbbbb"], expected: 1 },
        { fn: "longestUnique", args: [""], expected: 0 },
        { fn: "longestUnique", args: ["pwwkew"], expected: 3 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function longestUnique(s: string): number {\n  const last = new Map<string, number>()\n  let best = 0\n  let start = 0\n  for (let i = 0; i < s.length; i++) {\n    const seen = last.get(s[i]!)\n    if (seen !== undefined && seen >= start) start = seen + 1\n    last.set(s[i]!, i)\n    best = Math.max(best, i - start + 1)\n  }\n  return best\n}\n",
    },
  ),
  C(
    "algo-11-fib-memo",
    "algorithms",
    2,
    "Fibonacci with memoization (the oracle requires a memo structure plus exact values).",
    "src/solution.ts",
    { "src/solution.ts": stub("fib") },
    {
      properties: [
        { fn: "fib", args: [0], expected: 0 },
        { fn: "fib", args: [10], expected: 55 },
        { fn: "fib", args: [30], expected: 832040 },
      ],
      mustContain: ["memo"],
      perfBudgetMs: 2000,
    },
    {
      "src/solution.ts":
        "const memo = new Map<number, number>([[0, 0], [1, 1]])\n\nexport function fib(n: number): number {\n  const hit = memo.get(n)\n  if (hit !== undefined) return hit\n  const value = fib(n - 1) + fib(n - 2)\n  memo.set(n, value)\n  return value\n}\n",
    },
  ),
  C(
    "algo-12-two-sum-sorted",
    "algorithms",
    1,
    "Two-sum on a sorted array: 0-based index pair or empty.",
    "src/solution.ts",
    { "src/solution.ts": stub("twoSum") },
    {
      properties: [
        { fn: "twoSum", args: [[2, 7, 11, 15], 9], expected: [0, 1] },
        { fn: "twoSum", args: [[1, 2, 3], 7], expected: [] },
        { fn: "twoSum", args: [[-3, 0, 3], 0], expected: [0, 2] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function twoSum(nums: number[], target: number): number[] {\n  let lo = 0\n  let hi = nums.length - 1\n  while (lo < hi) {\n    const sum = nums[lo]! + nums[hi]!\n    if (sum === target) return [lo, hi]\n    if (sum < target) lo++\n    else hi--\n  }\n  return []\n}\n",
    },
  ),
  C(
    "algo-13-group-anagrams",
    "algorithms",
    2,
    "Group anagrams canonically: groups and members both sorted.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function groupAnagrams(words: string[]): string[][] {\n  const groups = new Map<string, string[]>()\n  for (const word of words) {\n    const key = [...word].sort().join("")\n    groups.set(key, [...(groups.get(key) ?? []), word])\n  }\n  return [...groups.values()]\n}\n',
    },
    {
      properties: [
        {
          fn: "groupAnagrams",
          args: [["eat", "tea", "tan", "ate", "nat", "bat"]],
          expected: [["ate", "eat", "tea"], ["bat"], ["nat", "tan"]],
        },
        { fn: "groupAnagrams", args: [[]], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        'export function groupAnagrams(words: string[]): string[][] {\n  const groups = new Map<string, string[]>()\n  for (const word of words) {\n    const key = [...word].sort().join("")\n    groups.set(key, [...(groups.get(key) ?? []), word])\n  }\n  return [...groups.values()].map((group) => group.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!))\n}\n',
    },
  ),
  C(
    "algo-14-knapsack",
    "algorithms",
    3,
    "0/1 knapsack maximum value for small integer inputs.",
    "src/solution.ts",
    { "src/solution.ts": stub("knapsack") },
    {
      properties: [
        { fn: "knapsack", args: [[1, 3, 4, 5], [1, 4, 5, 7], 7], expected: 9 },
        { fn: "knapsack", args: [[2], [3], 1], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function knapsack(weights: number[], values: number[], capacity: number): number {\n  const dp = Array(capacity + 1).fill(0) as number[]\n  for (let i = 0; i < weights.length; i++)\n    for (let w = capacity; w >= weights[i]!; w--) dp[w] = Math.max(dp[w]!, dp[w - weights[i]!]! + values[i]!)\n  return dp[capacity]!\n}\n",
    },
  ),
  C(
    "algo-15-max-sliding-window",
    "algorithms",
    3,
    "Maximum of each sliding window of size k.",
    "src/solution.ts",
    { "src/solution.ts": stub("maxWindow") },
    {
      properties: [
        { fn: "maxWindow", args: [[1, 3, -1, -3, 5, 3, 6, 7], 3], expected: [3, 3, 5, 5, 6, 7] },
        { fn: "maxWindow", args: [[1], 1], expected: [1] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function maxWindow(nums: number[], k: number): number[] {\n  const deque: number[] = []\n  const out: number[] = []\n  for (let i = 0; i < nums.length; i++) {\n    while (deque.length && nums[deque[0]!]! <= i - k) deque.shift()\n    while (deque.length && nums[deque[deque.length - 1]!]! < nums[i]!) deque.pop()\n    deque.push(i)\n    if (i >= k - 1) out.push(nums[deque[0]!]!)\n  }\n  return out\n}\n",
    },
  ),
  C(
    "algo-16-dijkstra",
    "algorithms",
    3,
    "Dijkstra shortest distances from a source over weighted edges.",
    "src/solution.ts",
    { "src/solution.ts": stub("dijkstra") },
    {
      properties: [
        {
          fn: "dijkstra",
          args: [
            {
              a: [
                ["b", 1],
                ["c", 4],
              ],
              b: [["c", 2]],
              c: [],
            },
            "a",
          ],
          expected: { a: 0, b: 1, c: 3 },
        },
        { fn: "dijkstra", args: [{ a: [] }, "a"], expected: { a: 0 } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function dijkstra(graph: Record<string, Array<[string, number]>>, source: string): Record<string, number> {\n  const dist: Record<string, number> = { [source]: 0 }\n  const done = new Set<string>()\n  for (;;) {\n    let node: string | undefined\n    for (const candidate of Object.keys(graph))\n      if (!done.has(candidate) && dist[candidate] !== undefined && (node === undefined || dist[candidate]! < dist[node]!))\n        node = candidate\n    if (node === undefined) break\n    done.add(node)\n    for (const [next, weight] of graph[node] ?? []) {\n      const via = dist[node]! + weight\n      if (dist[next] === undefined || via < dist[next]!) dist[next] = via\n    }\n  }\n  return dist\n}\n",
    },
  ),
]
