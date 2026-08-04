// Shell RPC client — typed methods for the shell.* control-plane methods
// (nocx-ynsx). Sibling of DialogClient/ProfileClient over the same
// Dispatcher.
//
// shell.integrate is the renderer's path to the in-band bootstrap plan
// (spec §4.4): the wrapper line typed at a trusted prompt, the payload
// streamed through the raw-mode window, and the terminator that ends — or
// alone cancels — the stream. The renderer alone may call it, gated on
// PROMPT_READY && trusted && owned: consent changes authorisation, not the
// identity of the foreground process.

import type { ShellIntegrateResult } from './generated/shell.integrate'

// The narrow call surface the client needs, so it can construct over the
// Dispatcher, the WSClient, or a test double (vault-client.ts pattern).
export interface ShellRpc {
  call<T = unknown>(method: string, params?: object): Promise<T>
}

export class ShellClient {
  constructor(private rpc: ShellRpc) {}

  /** Fetch the in-band integration plan for a live session. The session id
   *  is server-authoritative (AD-7): the backend refuses ids that are not
   *  live in its registry, so a stale tab can never anchor a payload. */
  integrate(sessionId: string): Promise<ShellIntegrateResult> {
    return this.rpc.call('shell.integrate', { sessionId })
  }
}
