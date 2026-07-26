// Control-plane dispatcher: owns request-ID allocation, pending-request
// correlation, notification routing, disconnect/reconnect behaviour, and
// typed subscribe/unsubscribe.  WSClient and ProfileClient consume it.

export type NotificationHandler = (params: unknown) => void
export type LifecycleHandler = () => void

// Reconnect backoff: start at 250 ms, double each attempt, cap at 5 s.
// Jitter of up to 50 % of the current backoff is added so a reload storm
// from many clients does not synchronise onto the server.
const MIN_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 5000

interface PendingCall {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class Dispatcher {
  private ws: WebSocket | null = null
  private nextID = 1
  private pending = new Map<number, PendingCall>()
  private subscribers = new Map<string, Set<NotificationHandler>>()

  // Lifecycle subscribers.
  private connectHandlers = new Set<LifecycleHandler>()
  private disconnectHandlers = new Set<LifecycleHandler>()

  // Reconnect state.
  private _port = 0
  private _host = '127.0.0.1'
  private _token = ''
  private _closingDeliberately = false
  private _backoffMs = MIN_BACKOFF_MS
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // --- WebSocket lifecycle -------------------------------------------------

  connect(port: number, host = '127.0.0.1', token = ''): Promise<void> {
    this._port = port
    this._host = host
    this._token = token
    this._closingDeliberately = false
    this._backoffMs = MIN_BACKOFF_MS
    return this._connectInternal()
  }

  private _connectInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      const subprotocol = `nocx.token.${this._token}`
      const ws = new WebSocket(`ws://${this._host}:${this._port}/session`, subprotocol)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        this.fireConnect()
        resolve()
      }
      ws.onerror = () => reject(new Error('ws connection failed'))

      ws.addEventListener('message', this._onSocketMessage)
      ws.addEventListener(
        'close',
        () => {
          if (this.ws !== ws) return
          ws.removeEventListener('message', this._onSocketMessage)
          this.ws = null
          this.rejectAllPending('ws closed')
          this.fireDisconnect()
          if (!this._closingDeliberately) {
            this._scheduleReconnect()
          }
        },
        { once: true },
      )

      this.ws = ws
    })
  }

  close(): void {
    this._closingDeliberately = true
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.rejectAllPending('closed')
    this.subscribers.clear()
    this.connectHandlers.clear()
    this.disconnectHandlers.clear()
  }

  // --- RPC -----------------------------------------------------------------

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextID++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.pending.delete(id)
        reject(new Error('not connected'))
        return
      }
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  // --- Notifications -------------------------------------------------------

  /** Subscribe to a notification method. Returns an unsubscribe function. */
  subscribe(method: string, handler: NotificationHandler): () => void {
    let set = this.subscribers.get(method)
    if (!set) {
      set = new Set()
      this.subscribers.set(method, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  // --- Lifecycle subscriptions ---------------------------------------------

  onConnect(handler: LifecycleHandler): void {
    this.connectHandlers.add(handler)
  }

  onDisconnect(handler: LifecycleHandler): void {
    this.disconnectHandlers.add(handler)
  }

  // --- Accessors -----------------------------------------------------------

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** The current raw WebSocket, or null.  For data-plane binary frame
   *  handling in WSClient — the dispatcher only owns control-plane
   *  messages. */
  get socket(): WebSocket | null {
    return this.ws
  }

  /** For test introspection: the current reconnect backoff value. */
  get backoffMs(): number {
    return this._backoffMs
  }

  /** For test introspection: whether the reconnect timer is pending. */
  get reconnectPending(): boolean {
    return this._reconnectTimer !== null
  }

  // --- Internal message handling -------------------------------------------

  private _onSocketMessage = (ev: MessageEvent): void => {
    if (typeof ev.data !== 'string') return
    let msg: {
      id?: number
      result?: unknown
      error?: { code?: number; message?: string }
      method?: string
      params?: unknown
    }
    try {
      msg = JSON.parse(ev.data) as typeof msg
    } catch {
      return
    }

    // Response to a pending request.
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) {
        p.reject(new Error(msg.error.message ?? 'rpc error'))
      } else {
        p.resolve(msg.result)
      }
      return
    }

    // Notification — route by method.
    if (msg.method !== undefined) {
      const handlers = this.subscribers.get(msg.method)
      if (handlers) {
        for (const h of handlers) {
          h(msg.params)
        }
      }
    }
  }

  // --- Reconnect plumbing --------------------------------------------------

  private _scheduleReconnect(): void {
    if (this._reconnectTimer !== null) return
    const jitter = Math.random() * this._backoffMs * 0.5
    const delay = this._backoffMs + jitter
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      void this._tryReconnect()
    }, delay)
    this._backoffMs = Math.min(this._backoffMs * 2, MAX_BACKOFF_MS)
  }

  private async _tryReconnect(): Promise<void> {
    try {
      await this._connectInternal()
      this._backoffMs = MIN_BACKOFF_MS
    } catch {
      if (!this._closingDeliberately) {
        this._scheduleReconnect()
      }
    }
  }

  // --- Helpers -------------------------------------------------------------

  private rejectAllPending(reason: string): void {
    for (const p of this.pending.values()) {
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private fireConnect(): void {
    for (const h of this.connectHandlers) {
      h()
    }
  }

  private fireDisconnect(): void {
    for (const h of this.disconnectHandlers) {
      h()
    }
  }
}
