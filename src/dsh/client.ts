/**
 * Minimal DSH web-API client: HTTP JSON-RPC to /api/<method> plus the two
 * WebSocket downlinks (/api/events.mux, /api/events.host). Zero dependency on
 * the DSH checkout — the wire shapes live in types.ts.
 */
import WebSocket from 'ws'
import type {
  ClientRequest,
  CreateSessionPayload,
  CreateSessionValue,
  HistoryValue,
  HostFrame,
  ModelsValue,
  MuxFrame,
  PromptPayload,
  PromptValue,
  RpcResult,
  ServerResponse,
  SessionSummary,
} from './types.js'

export class DshRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`)
    this.name = 'DshRpcError'
  }
}

export type MuxListener = (frame: MuxFrame, rpcId: string) => void
export type HostListener = (frame: HostFrame) => void
export type StatusListener = (connected: boolean, error?: string) => void

export class DshClient {
  private rpcSeq = 0
  private muxSocket: WebSocket | null = null
  private hostSocket: WebSocket | null = null
  private muxListeners = new Set<MuxListener>()
  private hostListeners = new Set<HostListener>()
  private statusListeners = new Set<StatusListener>()
  private reconnectTimer: NodeJS.Timeout | null = null
  private backoffMs = 1000
  private closed = false
  private lastError: string | undefined

  constructor(readonly baseUrl: string) {}

  get connected(): boolean {
    return this.muxSocket?.readyState === WebSocket.OPEN
  }

  get lastErrorText(): string | undefined {
    return this.lastError
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  onMux(cb: MuxListener): () => void {
    this.muxListeners.add(cb)
    return () => this.muxListeners.delete(cb)
  }

  onHost(cb: HostListener): () => void {
    this.hostListeners.add(cb)
    return () => this.hostListeners.delete(cb)
  }

  // ---- HTTP RPC ----

  async call<T>(method: string, payload: unknown): Promise<T> {
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: `vsc-${Date.now()}-${++this.rpcSeq}`,
      method,
      payload,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
    } catch (error) {
      throw new DshRpcError(
        'network',
        `无法连接 DSH (${this.baseUrl})：${error instanceof Error ? error.message : String(error)}`,
        {},
      )
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new DshRpcError('http', `HTTP ${response.status}: ${text.slice(0, 300)}`, {})
    }
    let envelope: ServerResponse
    try {
      envelope = JSON.parse(await response.text()) as ServerResponse
    } catch (error) {
      throw new DshRpcError('protocol', `非法响应：${String(error)}`, {})
    }
    const result = envelope.result as RpcResult<T>
    if (!result.ok) {
      const err = result.error
      throw new DshRpcError(err.code, err.message, err.details ?? {})
    }
    return result.value
  }

  // ---- session API ----

  listSessions(): Promise<{ items: SessionSummary[] }> {
    return this.call('session.list', {})
  }

  createSession(payload: CreateSessionPayload): Promise<CreateSessionValue> {
    return this.call('session.create', payload)
  }

  history(sessionId: string, beforeSeq?: number, maxMessages?: number): Promise<HistoryValue> {
    return this.call('session.history', {
      sessionId,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      ...(maxMessages === undefined ? {} : { maxMessages }),
    })
  }

  models(sessionId: string): Promise<ModelsValue> {
    return this.call('session.models', { sessionId })
  }

  selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }> {
    return this.call('session.selectModel', {
      sessionId,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
  }

  prompt(sessionId: string, text: string): Promise<PromptValue> {
    const payload: PromptPayload = {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }
    return this.call('session.prompt', payload)
  }

  /**
   * Execute a slash-command line (e.g. `/permission workspace-write`) against
   * a session's command registry — the same RPC the web client uses. Void
   * commands (e.g. /echo) respond with NO value at all: their feedback is the
   * state change / session events, not a returned text.
   */
  executeCommand(sessionId: string, line: string): Promise<{ commandId: string; result: { kind: string; text?: string } } | undefined> {
    return this.call('commands/execute', { args: { agentId: sessionId, line } })
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.call('session.cancel', { sessionId })
  }

  /**
   * Answer (or cancel) a pending user-question / approval on the mux stream.
   * @param rpcId - the stable rpcId of the answerable server-request frame.
   * @param ok - true answers, false cancels (error code must be 'cancelled').
   * @param value - the answer payload for ok:true (question: {sessionId, answer}).
   */
  async respond(rpcId: string, ok: boolean, value: unknown): Promise<{ accepted: boolean; reason?: string }> {
    const envelope = ok
      ? { type: 'client-response', rpcId, result: { ok: true, value } }
      : { type: 'client-response', rpcId, result: { ok: false, error: { code: 'cancelled', message: 'cancelled by user', details: {} } } }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(`${this.baseUrl}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      })
      const body = (await response.json().catch(() => ({}))) as { accepted?: boolean; reason?: string }
      return { accepted: body.accepted === true, reason: body.reason }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---- WebSocket downlinks ----

  /** Open (or reopen) both event streams; safe to call repeatedly. */
  startStreams(): void {
    if (this.closed) return
    if (this.muxSocket === null) this.openMux()
    if (this.hostSocket === null) this.openHost()
  }

  private openMux(): void {
    const url = this.wsUrl('/api/events.mux')
    const socket = new WebSocket(url)
    this.muxSocket = socket
    socket.on('open', () => {
      this.backoffMs = 1000
      this.lastError = undefined
      this.emitStatus(true)
    })
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { method: string; rpcId?: string; payload: unknown }
        if (msg.method === 'session/event' || msg.payload) {
          const frame = msg.payload as MuxFrame
          for (const cb of this.muxListeners) cb(frame, msg.rpcId ?? '')
        }
      } catch {
        // ignore malformed frames
      }
    })
    socket.on('close', () => {
      this.muxSocket = null
      this.scheduleReconnect()
    })
    socket.on('error', (err) => {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus(false, this.lastError)
    })
  }

  private openHost(): void {
    const url = this.wsUrl('/api/events.host')
    const socket = new WebSocket(url)
    this.hostSocket = socket
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { method: string; payload: unknown }
        const frame = msg.payload as HostFrame
        for (const cb of this.hostListeners) cb(frame)
      } catch {
        // ignore
      }
    })
    socket.on('close', () => {
      this.hostSocket = null
      this.scheduleReconnect()
    })
    socket.on('error', (err) => {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus(false, this.lastError)
    })
  }

  private wsUrl(path: string): string {
    const base = this.baseUrl.replace(/^http/, 'ws')
    return `${base}${path}`
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000)
    this.emitStatus(false, this.lastError ?? '连接已断开，正在重连…')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed) return
      this.startStreams()
    }, delay)
  }

  private emitStatus(connected: boolean, error?: string): void {
    for (const cb of this.statusListeners) cb(connected, error)
  }

  /** Drop both sockets and stop reconnecting. */
  close(): void {
    this.closed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const socket of [this.muxSocket, this.hostSocket]) {
      if (socket !== null) {
        socket.removeAllListeners()
        socket.close()
      }
    }
    this.muxSocket = null
    this.hostSocket = null
    this.muxListeners.clear()
    this.hostListeners.clear()
    this.statusListeners.clear()
  }
}
