/**
 * URL opening, behind one seam (AD-8: one owner per behaviour).
 *
 * The same class of thing as clipboard.ts: a platform capability with a
 * Wails-backed path and a browser path, chosen by the runtime fact owned
 * in platform.ts. Any surface that opens a link — the Git panel's
 * open-on-hosting affordance today — uses this and nothing else.
 *
 * Two paths:
 * - web (no Wails runtime — the dev-web browser): `window.open`. This MUST
 *   run synchronously inside the click handler: a `window.open` issued
 *   after an `await` has lost the user gesture and popup blockers eat it.
 *   The platform is known synchronously (`currentPlatform`), so the choice
 *   is a branch inside `open()`, never an async probe of the transport.
 *   The tab opens with `noopener,noreferrer`: a tab opened from the panel
 *   must never get a handle back on the app's window.
 * - native (packaged app): `shell.openUrl` through the backend control
 *   plane. `window.open` inside a Wails webview does not reach the system
 *   browser; the backend's scheme validation
 *   (internal/transport/ws_openurl.go — http/https with a host, nothing
 *   else) is the control that keeps this path honest.
 *
 * Failure is a rejected promise, never a swallow: a popup blocked, the
 * native transport refusing, or a transport that throws synchronously all
 * reject, and the caller turns that into the visible toast.
 */
import { currentPlatform } from './platform'

/** The capability every surface opens a link through (AD-8: one owner per
 *  behaviour — the same class of thing as the clipboard seam). */
export interface UrlOpener {
  /** Open a URL, resolving when it was handed to a browser. Rejects when
   *  no browser could be reached — a popup blocked on the web path, the
   *  native transport refusing or missing. The caller surfaces the
   *  rejection; the opener never swallows. */
  open(url: string): Promise<void>
}

/** The native half: hand the URL to the system browser through the backend
 *  control plane (`shell.openUrl`). Matched structurally by
 *  GitPanelServices, which is what the composition root wires in. Declared
 *  as a property, not a method: the opener holds it and may call it
 *  detached, so it must be a standalone function, never a this-dependent
 *  method. */
export interface OpenUrlTransport {
  openUrl: (url: string) => Promise<unknown>
}

/** The browser half. The `window.open` call is the FIRST thing this
 *  function does — it is deliberately not `async` and awaits nothing, so
 *  it runs in the same tick as the click that reached it. An `async` here
 *  with an `await` above the call is the exact regression the
 *  synchronous-gesture test in open-url.test.ts is written to catch. */
function openInBrowser(url: string): Promise<void> {
  let win: Window | null
  try {
    win = window.open(url, '_blank', 'noopener,noreferrer')
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  if (win === null) {
    return Promise.reject(new Error('nocx: the browser refused the tab (popup blocked)'))
  }
  return Promise.resolve()
}

function openViaNative(native: OpenUrlTransport, url: string): Promise<void> {
  try {
    return native.openUrl(url).then(() => undefined)
  } catch (err) {
    // A transport that throws synchronously must still reject the returned
    // promise — the caller's .catch() is the visible toast, and a throw
    // here would escape before the catch attaches.
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
}

/** Create the URL opener. The platform decision is made per open, not at
 *  construction: it is a synchronous branch inside `open()`, so the web
 *  path's `window.open` still holds the click's user gesture, and a click
 *  before `bootstrapPlatform` resolved still picks the right path. */
export function createUrlOpener(native: OpenUrlTransport): UrlOpener {
  return {
    // NOT an async function, and nothing is awaited above the branch: the
    // web path must run window.open in the same tick as the click.
    open(url: string): Promise<void> {
      if (currentPlatform() === 'web') return openInBrowser(url)
      return openViaNative(native, url)
    },
  }
}
