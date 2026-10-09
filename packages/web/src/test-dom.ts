// Test-only DOM setup (#130): happy-dom provides the browser globals the
// client Solid build needs (`document` for builders, `Node` for type
// checks inside `insert`). Every global the window owns and the test realm
// lacks is installed, so components render exactly as in a browser.
import { Window } from "happy-dom"

/** Install a fresh happy-dom window onto globalThis. */
export function installDom(): Window {
  const window = new Window()
  const scope = globalThis as Record<string, unknown>
  scope.window = window
  scope.document = window.document
  for (const key of Object.getOwnPropertyNames(window)) {
    if (!(key in globalThis)) {
      try {
        scope[key] = (window as unknown as Record<string, unknown>)[key]
      } catch {
        // Read-only or exotic globals are skipped.
      }
    }
  }
  document.body.innerHTML = ""
  return window
}
