// FilesClient — the files.* control-plane seam (design §5.2). One client,
// four methods, every result a GENERATED type: the renderer declares nothing
// of its own, because a hand-written type can want a field the wire does not
// carry, which is the defect the whole contracts/ directory exists to prevent.
// The panel consumes it through FilesPanelServices so tests can substitute a
// fake without a WebSocket (the ports pattern, nocx-wzc4).

import type { Dispatcher } from '../dispatcher'
import type { FilesOpenResult } from '../generated/files.open'
import type { FilesListResult } from '../generated/files.list'
import type { FilesReadResult } from '../generated/files.read'
import type { FilesCloseResult } from '../generated/files.close'

class FilesClient {
  constructor(private dispatcher: Dispatcher) {}

  /** Open a binding for one session: the backend issues the bindingId every
   *  later call echoes, plus the root the tree starts at (D1, D2). rootPath
   *  is the verified OSC 7 cwd when the composition layer has one — the one
   *  client-minted input that is an address, never an identity (D4). */
  open(sessionId: string, rootPath?: string): Promise<FilesOpenResult> {
    return this.dispatcher.call<FilesOpenResult>(
      'files.open',
      rootPath ? { sessionId, rootPath } : { sessionId },
    )
  }

  /** One page of one directory: ok, tooLarge or timedOut — state is the
   *  discriminator and the caller switches on it first (D14). */
  list(bindingId: string, path: string, offset: number, limit: number): Promise<FilesListResult> {
    return this.dispatcher.call<FilesListResult>('files.list', { bindingId, path, offset, limit })
  }

  /** Bounded content plus the canonical identity of what was actually read —
   *  the viewer's singletonKey input; the panel reads to obtain a file's
   *  canonical before handing it to the opener (D12). */
  read(bindingId: string, path: string, maxBytes: number): Promise<FilesReadResult> {
    return this.dispatcher.call<FilesReadResult>('files.read', { bindingId, path, maxBytes })
  }

  /** Release the binding — its provider, its pooled SSH reference, its
   *  watches. An empty result is still the contract. */
  close(bindingId: string): Promise<FilesCloseResult> {
    return this.dispatcher.call<FilesCloseResult>('files.close', { bindingId })
  }
}

/** The panel's entire backend surface, so a test can substitute a fake. */
export interface FilesPanelServices {
  open(sessionId: string, rootPath?: string): Promise<FilesOpenResult>
  list(bindingId: string, path: string, offset: number, limit: number): Promise<FilesListResult>
  read(bindingId: string, path: string, maxBytes: number): Promise<FilesReadResult>
  close(bindingId: string): Promise<FilesCloseResult>
}

/** Real implementation over the dispatcher. */
export function createFilesPanelServices(dispatcher: Dispatcher): FilesPanelServices {
  const client = new FilesClient(dispatcher)
  return {
    open: (sessionId, rootPath) => client.open(sessionId, rootPath),
    list: (bindingId, path, offset, limit) => client.list(bindingId, path, offset, limit),
    read: (bindingId, path, maxBytes) => client.read(bindingId, path, maxBytes),
    close: (bindingId) => client.close(bindingId),
  }
}
