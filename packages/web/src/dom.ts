// Minimal DOM builders (#130, clean-room): `h`/`svgEl` plus Solid's
// `insert` for reactive children. Two toolchain facts force this shape:
// bun's test runner cannot apply the Solid JSX transform (so JSX components
// are untestable here), and `solid-js/html` compiles templates with
// `new Function`, which the daemon's strict CSP (`script-src 'self'`, #129)
// refuses in a real browser (caught by the screenshot run). Direct DOM calls
// are transform-free, eval-free, and render identically under test and in
// the production Vite build.
import { createEffect } from "solid-js"
import { insert } from "solid-js/web"

export type Child = Node | string | number | boolean | null | undefined | (() => Child) | readonly Child[]

const SVG_NS = "http://www.w3.org/2000/svg"

const setAttr = (node: Element, name: string, value: string): void => {
  if (name === "className") node.setAttribute("class", value)
  else node.setAttribute(name, value)
}

/**
 * Append one child: static strings become text nodes, and thunks are
 * wrapped so they always resolve to nodes. (Solid's `insert` with a string
 * *replaces* the parent's content — feeding it a raw string or a thunk
 * that resolves to one wipes previously appended siblings. `insert` is
 * only used for functions and arrays, which need its reactivity.)
 */
const toNode = (value: Child): Node => {
  if (value instanceof Node) return value
  if (typeof value === "string" || typeof value === "number") return document.createTextNode(String(value))
  if (Array.isArray(value)) {
    const fragment = document.createDocumentFragment()
    for (const entry of value) fragment.appendChild(toNode(entry))
    return fragment
  }
  return document.createTextNode("")
}

const append = (node: Element, kid: Child): void => {
  if (kid === null || kid === undefined || typeof kid === "boolean") return
  if (kid instanceof Node) node.appendChild(kid)
  else if (typeof kid === "string" || typeof kid === "number") node.appendChild(document.createTextNode(String(kid)))
  else if (typeof kid === "function") {
    // Dynamic regions need an explicit marker: marker-less inserts on one
    // parent clobber each other's ranges on update (order breaks, stale
    // nodes survive). The marker pins this region's start/end.
    const marker = document.createTextNode("")
    node.appendChild(marker)
    insert(node, (() => toNode(kid())) as never, marker)
  } else insert(node, kid as never)
}

/** An element with static or reactive attributes and inserted children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | (() => string)> | null,
  ...kids: readonly Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs)
    for (const [name, value] of Object.entries(attrs)) {
      if (typeof value === "function") {
        const read = value
        createEffect(() => setAttr(node, name, read()))
      } else setAttr(node, name, value)
    }
  for (const kid of kids) append(node, kid)
  return node
}

/** An SVG element: same contract as `h`, in the SVG namespace. */
export function svgEl(
  tag: string,
  attrs: Record<string, string | number | (() => string)> | null,
  ...kids: readonly Child[]
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  if (attrs)
    for (const [name, value] of Object.entries(attrs)) {
      if (typeof value === "function") {
        const read = value
        createEffect(() => node.setAttribute(name, read()))
      } else node.setAttribute(name, String(value))
    }
  for (const kid of kids) append(node as unknown as Element, kid)
  return node
}
