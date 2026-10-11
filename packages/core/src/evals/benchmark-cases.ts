// Benchmark catalog (#171): 54 isolated software engineering instances across
// algorithms, refactoring, API integration and debugging. Each case is a seed
// workspace (stub or buggy code) plus a hidden oracle (properties, source
// constraints, perf budget) and a verified reference solution. The oracle
// self-check (benchmarks.test.ts) grades every reference green and every seed
// red, proving the oracle discriminates.
import type { BenchmarkCase } from "./benchmarks.ts"

const C = (
  id: BenchmarkCase["id"],
  category: BenchmarkCase["category"],
  difficulty: BenchmarkCase["difficulty"],
  description: string,
  entry: string,
  files: BenchmarkCase["files"],
  oracle: BenchmarkCase["oracle"],
  reference: BenchmarkCase["reference"],
): BenchmarkCase => ({ id, category, difficulty, description, entry, files, oracle, reference })

const stub = (fn: string) => `export function ${fn}(): never {\n  throw new Error("not implemented")\n}\n`

export const BENCHMARKS: readonly BenchmarkCase[] = [
  // ------------------------------------------------------- algorithms (16)
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
  // ------------------------------------------------------ refactoring (12)
  // Seeds work but smell; the oracle pins behaviour AND the refactored shape,
  // so seeds fail on constraints while references pass both.
  C(
    "ref-01-sum-reduce",
    "refactoring",
    1,
    "Replace the accumulation loop with reduce.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function total(prices: number[]): number {\n  let sum = 0\n  for (let i = 0; i < prices.length; i++) sum += prices[i]!\n  return sum\n}\n",
    },
    {
      properties: [
        { fn: "total", args: [[1, 2, 3]], expected: 6 },
        { fn: "total", args: [[]], expected: 0 },
      ],
      mustContain: [".reduce("],
      mustNotContain: ["for ("],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function total(prices: number[]): number {\n  return prices.reduce((a, b) => a + b, 0)\n}\n",
    },
  ),
  C(
    "ref-02-filter-map",
    "refactoring",
    1,
    "Replace the filter loop with filter/map.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function bigNames(users: Array<{name: string; age: number}>): string[] {\n  const out: string[] = []\n  for (const u of users) {\n    if (u.age >= 18) out.push(u.name.toUpperCase())\n  }\n  return out\n}\n",
    },
    {
      properties: [
        {
          fn: "bigNames",
          args: [
            [
              { name: "ann", age: 20 },
              { name: "bo", age: 10 },
            ],
          ],
          expected: ["ANN"],
        },
        { fn: "bigNames", args: [[]], expected: [] },
      ],
      mustContain: [".filter(", ".map("],
      mustNotContain: ["for ("],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function bigNames(users: Array<{name: string; age: number}>): string[] {\n  return users.filter((u) => u.age >= 18).map((u) => u.name.toUpperCase())\n}\n",
    },
  ),
  C(
    "ref-03-extract-discount",
    "refactoring",
    2,
    "Extract the inline discount rule into an applyDiscount helper.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function price(cart: number[], vip: boolean): number {\n  const sub = cart.reduce((a, b) => a + b, 0)\n  if (vip) return sub * 0.8\n  return sub\n}\n",
    },
    {
      properties: [
        { fn: "price", args: [[10, 20], true], expected: 24 },
        { fn: "price", args: [[10], false], expected: 10 },
      ],
      mustContain: ["function applyDiscount"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "function applyDiscount(sub: number, vip: boolean): number {\n  return vip ? sub * 0.8 : sub\n}\n\nexport function price(cart: number[], vip: boolean): number {\n  return applyDiscount(cart.reduce((a, b) => a + b, 0), vip)\n}\n",
    },
  ),
  C(
    "ref-04-early-return",
    "refactoring",
    1,
    "Flatten nested conditionals into guard clauses.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function label(age: number): string {\n  let out = 'minor'\n  if (age >= 18) {\n    out = 'adult'\n    if (age >= 65) out = 'senior'\n  }\n  return out\n}\n",
    },
    {
      properties: [
        { fn: "label", args: [10], expected: "minor" },
        { fn: "label", args: [30], expected: "adult" },
        { fn: "label", args: [70], expected: "senior" },
      ],
      mustContain: ["return 'senior'"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function label(age: number): string {\n  if (age >= 65) return 'senior'\n  if (age >= 18) return 'adult'\n  return 'minor'\n}\n",
    },
  ),
  C(
    "ref-05-const-bindings",
    "refactoring",
    1,
    "Use const for bindings that are never reassigned.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function circle(r: number): {area: number; circ: number} {\n  let area = Math.PI * r * r\n  let circ = 2 * Math.PI * r\n  return { area, circ }\n}\n",
    },
    {
      properties: [{ fn: "circle", args: [1], expected: { area: Math.PI, circ: 2 * Math.PI } }],
      mustNotContain: ["let "],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function circle(r: number): {area: number; circ: number} {\n  const area = Math.PI * r * r\n  const circ = 2 * Math.PI * r\n  return { area, circ }\n}\n",
    },
  ),
  C(
    "ref-06-template-literal",
    "refactoring",
    1,
    "Replace string concatenation with a template literal.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function greet(name: string, n: number): string {\n  return 'Hello, ' + name + '! You have ' + n + ' messages.'\n}\n",
    },
    {
      properties: [{ fn: "greet", args: ["Ann", 3], expected: "Hello, Ann! You have 3 messages." }],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional embedded template syntax under test.
      mustContain: ["${name}"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional embedded template syntax under test.
        "export function greet(name: string, n: number): string {\n  return `Hello, ${name}! You have ${n} messages.`\n}\n",
    },
  ),
  C(
    "ref-07-destructure",
    "refactoring",
    1,
    "Destructure the user object instead of repeating property access.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function fullname(user: {first: string; last: string}): string {\n  return user.first + ' ' + user.last\n}\n",
    },
    {
      properties: [{ fn: "fullname", args: [{ first: "Ada", last: "Lovelace" }], expected: "Ada Lovelace" }],
      mustContain: ["const { first, last }"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function fullname(user: {first: string; last: string}): string {\n  const { first, last } = user\n  return first + ' ' + last\n}\n",
    },
  ),
  C(
    "ref-08-pure-take-last",
    "refactoring",
    2,
    "Stop mutating the input: return the tail without pop.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function takeLast(items: number[]): {item: number | undefined; rest: number[]} {\n  const item = items.pop()\n  return { item, rest: items }\n}\n",
    },
    {
      properties: [
        { fn: "takeLast", args: [[1, 2, 3]], expected: { item: 3, rest: [1, 2] } },
        { fn: "takeLast", args: [[]], expected: { item: undefined, rest: [] } },
      ],
      mustContain: [".slice("],
      mustNotContain: [".pop("],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function takeLast(items: number[]): {item: number | undefined; rest: number[]} {\n  return { item: items[items.length - 1], rest: items.slice(0, -1) }\n}\n",
    },
  ),
  C(
    "ref-09-async-await",
    "refactoring",
    2,
    "Replace the promise chain with async/await.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "function load(): Promise<number> {\n  return Promise.resolve(21)\n}\n\nexport function doubled(): Promise<number> {\n  return load().then((x) => x * 2)\n}\n",
    },
    {
      properties: [{ fn: "doubled", args: [], expected: 42 }],
      mustContain: ["await"],
      mustNotContain: [".then("],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "function load(): Promise<number> {\n  return Promise.resolve(21)\n}\n\nexport async function doubled(): Promise<number> {\n  const x = await load()\n  return x * 2\n}\n",
    },
  ),
  C(
    "ref-10-named-constant",
    "refactoring",
    1,
    "Name the magic tax rate.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function withTax(sub: number): number {\n  return sub + sub * 0.07\n}\n",
    },
    {
      properties: [{ fn: "withTax", args: [100], expected: 107 }],
      mustContain: ["TAX_RATE"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "const TAX_RATE = 0.07\n\nexport function withTax(sub: number): number {\n  return sub + sub * TAX_RATE\n}\n",
    },
  ),
  C(
    "ref-11-remove-dead-code",
    "refactoring",
    1,
    "Delete the unused legacy helper.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function double(n: number): number {\n  return n * 2\n}\n\nfunction legacyCompute(n: number): number {\n  return n + n\n}\n",
    },
    {
      properties: [{ fn: "double", args: [21], expected: 42 }],
      mustNotContain: ["legacyCompute"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts": "export function double(n: number): number {\n  return n * 2\n}\n",
    },
  ),
  C(
    "ref-12-flatten-conditionals",
    "refactoring",
    1,
    "Collapse the nested if/else into one boolean expression.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function canEdit(role: string, isOwner: boolean): boolean {\n  if (role === 'admin') {\n    return true\n  } else {\n    if (isOwner) {\n      return true\n    } else {\n      return false\n    }\n  }\n}\n",
    },
    {
      properties: [
        { fn: "canEdit", args: ["admin", false], expected: true },
        { fn: "canEdit", args: ["user", true], expected: true },
        { fn: "canEdit", args: ["user", false], expected: false },
      ],
      mustContain: ["||"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function canEdit(role: string, isOwner: boolean): boolean {\n  return role === 'admin' || isOwner\n}\n",
    },
  ),
  // -------------------------------------------------- api-integration (12)
  C(
    "api-01-paginated-fetch",
    "api-integration",
    2,
    "Walk numbered pages until a page is missing, concatenating items.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function fetchAll(client: {pages: Record<number, number[]>}, start: number): number[] {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "fetchAll", args: [{ pages: { 1: [1, 2], 2: [3] } }, 1], expected: [1, 2, 3] },
        { fn: "fetchAll", args: [{ pages: { 1: [1, 2], 2: [3] } }, 2], expected: [3] },
        { fn: "fetchAll", args: [{ pages: {} }, 1], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function fetchAll(client: {pages: Record<number, number[]>}, start: number): number[] {\n  const out: number[] = []\n  let page = start\n  while (client.pages[page] !== undefined) {\n    out.push(...client.pages[page]!)\n    page++\n  }\n  return out\n}\n",
    },
  ),
  C(
    "api-02-retry-backoff",
    "api-integration",
    2,
    "Retry a failing client up to maxAttempts, reporting value and attempts.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function fetchWithRetry(client: {failuresLeft: number; value: number}, maxAttempts: number): {value: number; attempts: number} {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "fetchWithRetry", args: [{ failuresLeft: 2, value: 7 }, 3], expected: { value: 7, attempts: 3 } },
        { fn: "fetchWithRetry", args: [{ failuresLeft: 5, value: 7 }, 3], expected: { value: -1, attempts: 3 } },
        { fn: "fetchWithRetry", args: [{ failuresLeft: 0, value: 9 }, 3], expected: { value: 9, attempts: 1 } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function fetchWithRetry(client: {failuresLeft: number; value: number}, maxAttempts: number): {value: number; attempts: number} {\n  let attempts = 0\n  let left = client.failuresLeft\n  while (attempts < maxAttempts) {\n    attempts++\n    if (left > 0) left--\n    else return { value: client.value, attempts }\n  }\n  return { value: -1, attempts }\n}\n",
    },
  ),
  C(
    "api-03-debounce",
    "api-integration",
    3,
    "Trailing-edge debounce over timestamped events: fire an event only when nothing newer arrives within wait.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function debounce(events: Array<[number, string]>, wait: number): Array<[number, string]> {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "debounce",
          args: [
            [
              [0, "a"],
              [50, "b"],
              [200, "c"],
            ],
            100,
          ],
          expected: [
            [50, "b"],
            [200, "c"],
          ],
        },
        { fn: "debounce", args: [[[0, "a"]], 100], expected: [[0, "a"]] },
        { fn: "debounce", args: [[], 100], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function debounce(events: Array<[number, string]>, wait: number): Array<[number, string]> {\n  const out: Array<[number, string]> = []\n  for (let i = 0; i < events.length; i++) {\n    const next = events[i + 1]\n    if (!next || next[0] - events[i]![0] > wait) out.push(events[i]!)\n  }\n  return out\n}\n",
    },
  ),
  C(
    "api-04-cache-aside",
    "api-integration",
    2,
    "Cache-aside read: serve from cache when present, else read the db once.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function getUser(cache: Record<string, string>, db: Record<string, string>, id: string): {value: string; dbHits: number} {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "getUser",
          args: [{ u1: "Ann" }, { u1: "Ann", u2: "Bo" }, "u1"],
          expected: { value: "Ann", dbHits: 0 },
        },
        {
          fn: "getUser",
          args: [{ u1: "Ann" }, { u1: "Ann", u2: "Bo" }, "u2"],
          expected: { value: "Bo", dbHits: 1 },
        },
        { fn: "getUser", args: [{}, {}, "ghost"], expected: { value: "missing", dbHits: 1 } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function getUser(cache: Record<string, string>, db: Record<string, string>, id: string): {value: string; dbHits: number} {\n  if (cache[id] !== undefined) return { value: cache[id]!, dbHits: 0 }\n  return { value: db[id] ?? 'missing', dbHits: 1 }\n}\n",
    },
  ),
  C(
    "api-05-csv-parse",
    "api-integration",
    3,
    "Parse CSV with quoted fields, embedded commas and doubled quotes.",
    "src/solution.ts",
    { "src/solution.ts": 'export function parseCsv(text: string): string[][] {\n  throw new Error("stub")\n}\n' },
    {
      properties: [
        {
          fn: "parseCsv",
          args: ["a,b\nc,d"],
          expected: [
            ["a", "b"],
            ["c", "d"],
          ],
        },
        { fn: "parseCsv", args: ['a,"b,c",d'], expected: [["a", "b,c", "d"]] },
        { fn: "parseCsv", args: ['a,"b""c"'], expected: [["a", 'b"c']] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function parseCsv(text: string): string[][] {\n  const rows: string[][] = []\n  let row: string[] = []\n  let field = ''\n  let quoted = false\n  for (let i = 0; i < text.length; i++) {\n    const ch = text[i]!\n    if (quoted) {\n      if (ch === '\"') {\n        if (text[i + 1] === '\"') {\n          field += '\"'\n          i++\n        } else quoted = false\n      } else field += ch\n    } else if (ch === '\"') quoted = true\n    else if (ch === ',') {\n      row.push(field)\n      field = ''\n    } else if (ch === '\\n') {\n      row.push(field)\n      rows.push(row)\n      row = []\n      field = ''\n    } else field += ch\n  }\n  row.push(field)\n  rows.push(row)\n  return rows\n}\n",
    },
  ),
  C(
    "api-06-url-router",
    "api-integration",
    2,
    "Match a path against :param routes, extracting parameters.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function matchRoute(routes: string[], path: string): {route: string; params: Record<string, string>} | null {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "matchRoute",
          args: [["/users/:id", "/users/new"], "/users/42"],
          expected: { route: "/users/:id", params: { id: "42" } },
        },
        {
          fn: "matchRoute",
          args: [["/users/new", "/users/:id"], "/users/new"],
          expected: { route: "/users/new", params: {} },
        },
        { fn: "matchRoute", args: [["/a"], "/b"], expected: null },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function matchRoute(routes: string[], path: string): {route: string; params: Record<string, string>} | null {\n  const parts = path.split('/').filter((p) => p.length > 0)\n  for (const route of routes) {\n    const rparts = route.split('/').filter((p) => p.length > 0)\n    if (rparts.length !== parts.length) continue\n    const params: Record<string, string> = {}\n    let ok = true\n    for (let i = 0; i < rparts.length; i++) {\n      if (rparts[i]!.startsWith(':')) params[rparts[i]!.slice(1)] = parts[i]!\n      else if (rparts[i] !== parts[i]) {\n        ok = false\n        break\n      }\n    }\n    if (ok) return { route, params }\n  }\n  return null\n}\n",
    },
  ),
  C(
    "api-07-event-emitter",
    "api-integration",
    2,
    "Run an op script against a minimal emitter, returning received payloads.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function runEmitter(ops: Array<[string, ...unknown[]]>): unknown[][] {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "runEmitter",
          args: [
            [
              ["on", "a"],
              ["emit", "a", 1],
              ["emit", "b", 2],
              ["emit", "a", 3],
            ],
          ],
          expected: [
            ["a", 1],
            ["a", 3],
          ],
        },
        { fn: "runEmitter", args: [[["emit", "x", 1]]], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function runEmitter(ops: Array<[string, ...unknown[]]>): unknown[][] {\n  const listeners = new Map<string, Array<(p: unknown) => void>>()\n  const received: unknown[][] = []\n  for (const [op, ...rest] of ops) {\n    if (op === 'on') {\n      const event = rest[0] as string\n      const fn = (p: unknown) => {\n        received.push([event, p])\n      }\n      listeners.set(event, [...(listeners.get(event) ?? []), fn])\n    } else {\n      for (const fn of listeners.get(rest[0] as string) ?? []) fn(rest[1])\n    }\n  }\n  return received\n}\n",
    },
  ),
  C(
    "api-08-deep-merge",
    "api-integration",
    2,
    "Deep-merge config objects: nested objects merge, arrays and scalars replace.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        {
          fn: "deepMerge",
          args: [
            { a: 1, n: { x: 1, y: 2 } },
            { n: { y: 3 }, b: 2 },
          ],
          expected: { a: 1, n: { x: 1, y: 3 }, b: 2 },
        },
        { fn: "deepMerge", args: [{ l: [1] }, { l: [2, 3] }], expected: { l: [2, 3] } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {\n  const out: Record<string, unknown> = { ...a }\n  for (const [k, v] of Object.entries(b)) {\n    const current = out[k]\n    if (v !== null && typeof v === 'object' && !Array.isArray(v) && current !== null && typeof current === 'object' && !Array.isArray(current))\n      out[k] = deepMerge(current as Record<string, unknown>, v as Record<string, unknown>)\n    else out[k] = v\n  }\n  return out\n}\n",
    },
  ),
  C(
    "api-09-webhook-hmac",
    "api-integration",
    3,
    "Verify a webhook HMAC-SHA256 signature in constant time.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function isValidSignature(payload: string, secret: string, signature: string): boolean {\n  return signature === payload\n}\n",
    },
    {
      properties: [
        {
          fn: "isValidSignature",
          args: ["hello", "s3cret", "e5a01537481fa0b2c697f787c7aff885412cf0760d08e08502259b39d2d6ae68"],
          expected: true,
        },
        { fn: "isValidSignature", args: ["hello", "s3cret", "deadbeef"], expected: false },
        {
          fn: "isValidSignature",
          args: ["hello", "wrong", "e5a01537481fa0b2c697f787c7aff885412cf0760d08e08502259b39d2d6ae68"],
          expected: false,
        },
      ],
      mustContain: ["timingSafeEqual"],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "import { createHmac, timingSafeEqual } from 'node:crypto'\n\nexport function isValidSignature(payload: string, secret: string, signature: string): boolean {\n  const expected = createHmac('sha256', secret).update(payload).digest('hex')\n  const a = Buffer.from(signature)\n  const b = Buffer.from(expected)\n  return a.length === b.length && timingSafeEqual(a, b)\n}\n",
    },
  ),
  C(
    "api-10-slugify",
    "api-integration",
    1,
    "Slugify a title: lowercase, non-alphanumerics to single dashes, trimmed.",
    "src/solution.ts",
    { "src/solution.ts": 'export function slugify(title: string): string {\n  throw new Error("stub")\n}\n' },
    {
      properties: [
        { fn: "slugify", args: ["Hello, World!"], expected: "hello-world" },
        { fn: "slugify", args: ["  A--B  "], expected: "a-b" },
        { fn: "slugify", args: [""], expected: "" },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function slugify(title: string): string {\n  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')\n}\n",
    },
  ),
  C(
    "api-11-config-flatten",
    "api-integration",
    2,
    "Flatten nested config into dotted keys under a prefix.",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function flatten(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "flatten", args: [{ a: { b: 1 }, c: 2 }, ""], expected: { "a.b": 1, c: 2 } },
        { fn: "flatten", args: [{ x: { y: { z: 3 } } }, "r"], expected: { "r.x.y.z": 3 } },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function flatten(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {\n  const out: Record<string, unknown> = {}\n  for (const [k, v] of Object.entries(obj)) {\n    const key = prefix ? prefix + '.' + k : k\n    if (v !== null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, key))\n    else out[key] = v\n  }\n  return out\n}\n",
    },
  ),
  C(
    "api-12-chunk",
    "api-integration",
    1,
    "Chunk items into fixed-size batches; non-positive sizes yield [].",
    "src/solution.ts",
    {
      "src/solution.ts":
        'export function chunk(items: number[], size: number): number[][] {\n  throw new Error("stub")\n}\n',
    },
    {
      properties: [
        { fn: "chunk", args: [[1, 2, 3, 4, 5], 2], expected: [[1, 2], [3, 4], [5]] },
        { fn: "chunk", args: [[], 3], expected: [] },
        { fn: "chunk", args: [[1], 0], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function chunk(items: number[], size: number): number[][] {\n  if (size <= 0) return []\n  const out: number[][] = []\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))\n  return out\n}\n",
    },
  ),
  // ---------------------------------------------------------- debugging (14)
  // Seeds are real bugs: each fails at least one property while the reference
  // holds every property.
  C(
    "dbg-01-last-element",
    "debugging",
    1,
    "Return the last element; the seed reads one past the end.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function last(items: number[]): number | undefined {\n  return items[items.length]\n}\n",
    },
    {
      properties: [
        { fn: "last", args: [[1, 2, 3]], expected: 3 },
        { fn: "last", args: [[]], expected: undefined },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function last(items: number[]): number | undefined {\n  return items[items.length - 1]\n}\n",
    },
  ),
  C(
    "dbg-02-inclusive-range",
    "debugging",
    1,
    "Inclusive integer range; the seed drops the endpoint.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function range(lo: number, hi: number): number[] {\n  const out: number[] = []\n  for (let i = lo; i < hi; i++) out.push(i)\n  return out\n}\n",
    },
    {
      properties: [
        { fn: "range", args: [1, 5], expected: [1, 2, 3, 4, 5] },
        { fn: "range", args: [3, 3], expected: [3] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function range(lo: number, hi: number): number[] {\n  const out: number[] = []\n  for (let i = lo; i <= hi; i++) out.push(i)\n  return out\n}\n",
    },
  ),
  C(
    "dbg-03-null-guard",
    "debugging",
    1,
    "Read an optional name without crashing on null.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function getName(user: {name: string} | null): string {\n  return user!.name\n}\n",
    },
    {
      properties: [
        { fn: "getName", args: [{ name: "Al" }], expected: "Al" },
        { fn: "getName", args: [null], expected: "anon" },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function getName(user: {name: string} | null): string {\n  return user?.name ?? 'anon'\n}\n",
    },
  ),
  C(
    "dbg-04-float-money",
    "debugging",
    2,
    "Add fractional amounts without binary floating-point dust.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function addCents(a: number, b: number): number {\n  return a + b\n}\n",
    },
    {
      properties: [
        { fn: "addCents", args: [0.1, 0.2], expected: 0.3 },
        { fn: "addCents", args: [1.005, 0.005], expected: 1.01 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function addCents(a: number, b: number): number {\n  return Math.round((a + b) * 100) / 100\n}\n",
    },
  ),
  C(
    "dbg-05-rotate-modulo",
    "debugging",
    2,
    "Rotate left with rotation counts larger than the array.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function rotateLeft(items: number[], n: number): number[] {\n  return [...items.slice(n), ...items.slice(0, n)]\n}\n",
    },
    {
      properties: [
        { fn: "rotateLeft", args: [[1, 2, 3], 1], expected: [2, 3, 1] },
        { fn: "rotateLeft", args: [[1, 2, 3], 4], expected: [2, 3, 1] },
        { fn: "rotateLeft", args: [[], 5], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function rotateLeft(items: number[], n: number): number[] {\n  if (!items.length) return []\n  const k = ((n % items.length) + items.length) % items.length\n  return [...items.slice(k), ...items.slice(0, k)]\n}\n",
    },
  ),
  C(
    "dbg-06-leap-year",
    "debugging",
    2,
    "Full Gregorian leap-year rule; the seed forgets the century exception.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function isLeap(year: number): boolean {\n  return year % 4 === 0\n}\n",
    },
    {
      properties: [
        { fn: "isLeap", args: [1900], expected: false },
        { fn: "isLeap", args: [2000], expected: true },
        { fn: "isLeap", args: [2024], expected: true },
        { fn: "isLeap", args: [2023], expected: false },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function isLeap(year: number): boolean {\n  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)\n}\n",
    },
  ),
  C(
    "dbg-07-weekend-sunday",
    "debugging",
    2,
    "Weekend check over UTC weekdays; the seed thinks Sunday is day 7.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function isWeekend(ymd: string): boolean {\n  const [y, m, d] = ymd.split('-').map(Number)\n  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()\n  return day === 6 || day === 7\n}\n",
    },
    {
      properties: [
        { fn: "isWeekend", args: ["2026-10-11"], expected: true },
        { fn: "isWeekend", args: ["2026-10-10"], expected: true },
        { fn: "isWeekend", args: ["2026-10-12"], expected: false },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function isWeekend(ymd: string): boolean {\n  const [y, m, d] = ymd.split('-').map(Number)\n  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()\n  return day === 0 || day === 6\n}\n",
    },
  ),
  C(
    "dbg-08-highlight-literal",
    "debugging",
    2,
    "Highlight a literal word; the seed feeds it to RegExp unescaped.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function highlight(text: string, word: string): string {\n  return text.replace(new RegExp(word, 'g'), '<b>' + word + '</b>')\n}\n",
    },
    {
      properties: [
        { fn: "highlight", args: ["say C++ now", "C++"], expected: "say <b>C++</b> now" },
        { fn: "highlight", args: ["aaa", "a"], expected: "<b>a</b><b>a</b><b>a</b>" },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function highlight(text: string, word: string): string {\n  return text.split(word).join('<b>' + word + '</b>')\n}\n",
    },
  ),
  C(
    "dbg-09-average-empty",
    "debugging",
    1,
    "Average of an empty list is 0, not NaN.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function average(nums: number[]): number {\n  return nums.reduce((a, b) => a + b, 0) / nums.length\n}\n",
    },
    {
      properties: [
        { fn: "average", args: [[1, 2, 3]], expected: 2 },
        { fn: "average", args: [[]], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function average(nums: number[]): number {\n  if (!nums.length) return 0\n  return nums.reduce((a, b) => a + b, 0) / nums.length\n}\n",
    },
  ),
  C(
    "dbg-10-unique-words",
    "debugging",
    2,
    "Count distinct words case-insensitively over messy whitespace.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function countUniqueWords(text: string): number {\n  return new Set(text.split(' ')).size\n}\n",
    },
    {
      properties: [
        { fn: "countUniqueWords", args: ["a A b"], expected: 2 },
        { fn: "countUniqueWords", args: ["  hello   world hello "], expected: 2 },
        { fn: "countUniqueWords", args: [""], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function countUniqueWords(text: string): number {\n  const words = text.toLowerCase().split(/\\s+/).filter((w) => w.length > 0)\n  return new Set(words).size\n}\n",
    },
  ),
  C(
    "dbg-11-numeric-sort",
    "debugging",
    1,
    "Sort numbers by value, not lexicographically.",
    "src/solution.ts",
    {
      "src/solution.ts": "export function sortNumbers(nums: number[]): number[] {\n  return [...nums].sort()\n}\n",
    },
    {
      properties: [
        { fn: "sortNumbers", args: [[10, 9, 80]], expected: [9, 10, 80] },
        { fn: "sortNumbers", args: [[3, 1, 2]], expected: [1, 2, 3] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function sortNumbers(nums: number[]): number[] {\n  return [...nums].sort((a, b) => a - b)\n}\n",
    },
  ),
  C(
    "dbg-12-forgotten-await",
    "debugging",
    2,
    "Await the loader before reducing; the seed reduces a promise.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export async function sumLoaded(load: () => Promise<number[]>): Promise<number> {\n  const data = load() as unknown as number[]\n  return data.reduce((a, b) => a + b, 0)\n}\n",
    },
    {
      properties: [
        { fn: "sumLoaded", args: [() => Promise.resolve([1, 2, 3])], expected: 6 },
        { fn: "sumLoaded", args: [() => Promise.resolve([])], expected: 0 },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export async function sumLoaded(load: () => Promise<number[]>): Promise<number> {\n  const data = await load()\n  return data.reduce((a, b) => a + b, 0)\n}\n",
    },
  ),
  C(
    "dbg-13-page-one-based",
    "debugging",
    2,
    "1-based pagination; the seed slices 0-based.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function page(items: number[], pageNum: number, size: number): number[] {\n  return items.slice(pageNum * size, pageNum * size + size)\n}\n",
    },
    {
      properties: [
        { fn: "page", args: [[1, 2, 3, 4, 5], 1, 2], expected: [1, 2] },
        { fn: "page", args: [[1, 2, 3, 4, 5], 3, 2], expected: [5] },
        { fn: "page", args: [[1, 2], 5, 2], expected: [] },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function page(items: number[], pageNum: number, size: number): number[] {\n  return items.slice((pageNum - 1) * size, (pageNum - 1) * size + size)\n}\n",
    },
  ),
  C(
    "dbg-14-config-match",
    "debugging",
    2,
    "Compare configs independent of key order; the seed stringifies.",
    "src/solution.ts",
    {
      "src/solution.ts":
        "export function configsMatch(a: Record<string, number>, b: Record<string, number>): boolean {\n  return JSON.stringify(a) === JSON.stringify(b)\n}\n",
    },
    {
      properties: [
        {
          fn: "configsMatch",
          args: [
            { x: 1, y: 2 },
            { y: 2, x: 1 },
          ],
          expected: true,
        },
        { fn: "configsMatch", args: [{ x: 1 }, { x: 2 }], expected: false },
        { fn: "configsMatch", args: [{ x: 1 }, { x: 1, y: 2 }], expected: false },
      ],
      perfBudgetMs: 1000,
    },
    {
      "src/solution.ts":
        "export function configsMatch(a: Record<string, number>, b: Record<string, number>): boolean {\n  const ka = Object.keys(a).sort()\n  const kb = Object.keys(b).sort()\n  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[kb[i]!])\n}\n",
    },
  ),
]
