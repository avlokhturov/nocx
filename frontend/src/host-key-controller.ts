import type { HostKeyErrorEvidence } from './terminal-content'

export interface OpenHostKeyRequest {
  evidence: HostKeyErrorEvidence
  signal: AbortSignal
  resolve: (accepted: boolean) => void
  abort: () => void
  settled: boolean
}

/** Serialises open-time host-key decisions without losing the requesting tab. */
export class OpenHostKeyRequestQueue {
  private readonly waiting: OpenHostKeyRequest[] = []
  private activeRequest: OpenHostKeyRequest | null = null

  constructor(private readonly onActiveChange: (request: OpenHostKeyRequest | null) => void) {}

  request(evidence: HostKeyErrorEvidence, signal: AbortSignal): Promise<boolean> {
    // Promise.withResolvers needs ES2024 and this project targets ES2021, so
    // the resolver is captured via the executor form.
    let resolve!: (accepted: boolean) => void
    const promise = new Promise<boolean>((done) => {
      resolve = done
    })
    if (signal.aborted) {
      resolve(false)
      return promise
    }
    const request: OpenHostKeyRequest = {
      evidence,
      signal,
      resolve,
      settled: false,
      abort: () => {},
    }
    request.abort = () => this.settle(request, false)
    signal.addEventListener('abort', request.abort, { once: true })
    this.waiting.push(request)
    this.showNext()
    return promise
  }

  settle(request: OpenHostKeyRequest, accepted: boolean): void {
    if (request.settled) return
    request.settled = true
    request.signal.removeEventListener('abort', request.abort)
    if (this.activeRequest === request) {
      this.activeRequest = null
      this.onActiveChange(null)
      request.resolve(accepted)
      this.showNext()
      return
    }
    const queued = this.waiting.indexOf(request)
    if (queued >= 0) this.waiting.splice(queued, 1)
    request.resolve(accepted)
  }

  /** One successful trust write answers every queued tab for that exact key. */
  settleMatchingQueued(acceptedRequest: OpenHostKeyRequest): void {
    for (const request of [...this.waiting]) {
      if (
        request.evidence.knownHostsHost === acceptedRequest.evidence.knownHostsHost &&
        request.evidence.key === acceptedRequest.evidence.key
      ) {
        this.settle(request, true)
      }
    }
  }

  private showNext(): void {
    if (this.activeRequest || this.waiting.length === 0) return
    this.activeRequest = this.waiting.shift() ?? null
    this.onActiveChange(this.activeRequest)
  }
}
