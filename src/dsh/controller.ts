/**
 * ChatController: owns multiple DSH sessions for the current workspace — one
 * session per chat tab. Turns the mux/host event streams into renderable chat
 * models per session, applies model routing, and exposes granular events the
 * webview renders (filtered to the active session).
 */
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { DshClient, DshRpcError } from './client.js'
import { getDshConfig, ROUTE_MODE_KEY } from './config.js'
import { resolveModelId, routeModeLabel } from './router.js'
import type {
  AssistantChunkData,
  AssistantMessageData,
  ChatItem,
  ChatSessionMeta,
  ChatSnapshot,
  ChatTurn,
  ContentBlock,
  HostFrame,
  MuxFrame,
  RouteMode,
  SessionEvent,
  SessionSummary,
  ToolCallData,
  ToolResultData,
  TurnEndData,
  UserMessageData,
} from './types.js'

export type ControllerEvent =
  | { type: 'state'; snapshot: ChatSnapshot }
  | { type: 'itemAdd'; sessionId: string; turnId: number; item: ChatItem }
  | { type: 'itemUpdate'; sessionId: string; turnId: number; itemId: string; patch: Record<string, unknown> }
  | { type: 'turnStatus'; sessionId: string; turnId: number; status: ChatTurn['status']; model: string; errorMessage?: string }
  | { type: 'runState'; sessionId: string; running: boolean }
  | { type: 'mode'; mode: RouteMode }
  | { type: 'connection'; connected: boolean; error?: string }
  | { type: 'question'; sessionId: string; rpcId: string; questions: QuestionItem[] }
  | { type: 'questionResolved'; sessionId: string; rpcId: string; outcome: 'answered' | 'cancelled' }
  | { type: 'toast'; kind: 'error' | 'info' | 'warn'; text: string }

/** One user question the agent asked (wire-safe subset). */
export interface QuestionOption { label: string; description?: string }
export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

export interface QuestionAnswer { id: string; selected: string[]; custom?: string }

type Listener = (event: ControllerEvent) => void

const TEXT_TRUNCATE = 6000
const RESULT_TRUNCATE = 4000
const TITLE_PREFIX_LENGTH = 24
const MAX_HISTORY_TITLES = 50

/** Per-session state (one chat tab). */
interface SessionState {
  sessionId: string
  title: string
  persisted: boolean
  turns: ChatTurn[]
  turnSeq: number
  itemSeq: number
  running: boolean
  lastTurnFailed: boolean
  currentTurnId: number | undefined
  pendingTurnId: number | undefined
  stepTextItemId: string | undefined
  currentStep: number
  pendingTools: Map<string, string> // callId -> itemId
  /** Current permission preset of THIS session (from its projections). */
  permission: string
}

function newSessionState(sessionId: string, persisted: boolean, title = '新会话'): SessionState {
  return {
    sessionId,
    title,
    persisted,
    turns: [],
    turnSeq: 0,
    itemSeq: 0,
    running: false,
    lastTurnFailed: false,
    currentTurnId: undefined,
    pendingTurnId: undefined,
    stepTextItemId: undefined,
    currentStep: -1,
    pendingTools: new Map(),
    permission: '',
  }
}

export class ChatController implements vscode.Disposable {
  private client: DshClient
  private listeners = new Set<Listener>()
  private sessions = new Map<string, SessionState>()
  private activeSessionId: string | undefined
  private cwd: string | undefined
  private routeMode: RouteMode = 'auto'
  /** 'auto' = router, otherwise an explicit catalog model id. */
  private modelChoice = 'auto'
  private effort = 'high'
  private permissionOptions: string[] = ['read-only', 'workspace-write', 'danger-full-access']
  private catalogModels: string[] = []
  private lastError: string | undefined
  private lastConnected = false
  private disposed = false
  private emitTimer: NodeJS.Timeout | null = null
  private pendingPatches = new Map<string, { sessionId: string; turnId: number; itemId: string; patch: Record<string, unknown> }>()

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const cfg = getDshConfig()
    this.client = new DshClient(cfg.baseUrl)
    this.routeMode = ctx.globalState.get<RouteMode>(ROUTE_MODE_KEY, 'auto')
    this.modelChoice = ctx.globalState.get<string>('dsh.modelChoice', 'auto')
    this.effort = ctx.globalState.get<string>('dsh.effort', 'high')
    this.client.onStatus((connected, error) => {
      this.lastConnected = connected
      this.lastError = error
      this.emit({ type: 'connection', connected, error })
    })
    this.client.onMux((frame, rpcId) => this.onMuxFrame(frame, rpcId))
    this.client.onHost((frame) => this.onHostFrame(frame))
  }

  // ---- lifecycle ----

  /** Resolve the workspace cwd, restore the last-used session, open streams. */
  async init(): Promise<void> {
    const cfg = getDshConfig()
    this.cwd = resolveCwd(cfg)
    this.client.startStreams()
    try {
      await this.restoreSessions(this.cwd)
      await this.refreshCatalog()
      await this.refreshPermission()
    } catch (error) {
      this.emit({ type: 'toast', kind: 'error', text: errorMessage(error) })
    }
    this.emitState()
  }

  /**
   * List this workspace's DSH sessions and open the most recent one; the rest
   * become history entries (tabs appear as they are switched to).
   */
  private async restoreSessions(cwd: string): Promise<void> {
    const { items } = await this.client.listSessions()
    const norm = normalizePath(cwd)
    const mine = items
      .filter((item) => item.cwd !== undefined && normalizePath(item.cwd) === norm && !item.running)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (mine.length === 0) {
      // Fresh workspace: open one blank session so the tab bar has a home.
      const created = await this.client.createSession({ cwd, agentPreset: getDshConfig().agentPreset })
      const st = newSessionState(created.sessionId, true)
      this.sessions.set(st.sessionId, st)
      this.activeSessionId = st.sessionId
      return
    }
    const latest = mine[0]
    const st = newSessionState(latest.sessionId, true, sessionTitle(latest))
    this.sessions.set(st.sessionId, st)
    this.activeSessionId = st.sessionId
    await this.loadHistory(st)
  }

  private async loadHistory(st: SessionState): Promise<void> {
    const page = await this.client.history(st.sessionId, undefined, 300)
    const rebuilt = rebuildTurns(page.events.map((entry) => entry.event))
    if (rebuilt.length > 0) {
      st.turns = rebuilt
      st.turnSeq = Math.max(0, ...rebuilt.map((t) => t.id)) + 1
      st.lastTurnFailed = rebuilt[rebuilt.length - 1]?.status === 'error'
    }
  }

  async reconnect(): Promise<void> {
    const old = this.client
    old.close()
    const cfg = getDshConfig()
    this.client = new DshClient(cfg.baseUrl)
    this.client.onStatus((connected, error) => {
      this.lastConnected = connected
      this.lastError = error
      this.emit({ type: 'connection', connected, error })
    })
    this.client.onMux((frame, rpcId) => this.onMuxFrame(frame, rpcId))
    this.client.onHost((frame) => this.onHostFrame(frame))
    this.client.startStreams()
    this.emitState()
  }

  dispose(): void {
    this.disposed = true
    if (this.emitTimer !== null) clearTimeout(this.emitTimer)
    this.client.close()
    this.listeners.clear()
  }

  onEvent(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // ---- state access ----

  getActiveSessionId(): string | undefined { return this.activeSessionId }
  getCwd(): string | undefined { return this.cwd }
  isRunning(): boolean {
    const st = this.active()
    return st?.running ?? false
  }
  isRunningFor(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.running ?? false
  }
  getMode(): RouteMode { return this.routeMode }
  getSnapshot(): ChatSnapshot { return this.snapshot() }
  getConnectionState(): { connected: boolean; error?: string } {
    return { connected: this.lastConnected, error: this.lastError }
  }

  // ---- user actions ----

  /**
   * Send a prompt to a specific session (defaults to the active tab).
   * @param text - the prompt.
   * @param sessionId - target session; omitted = active.
   */
  async send(text: string, sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    const trimmed = text.trim()
    if (st === undefined || trimmed === '' || st.running) return
    const cfg = getDshConfig()
    if (st.title === '新会话' && !trimmed.startsWith('/')) {
      st.title = trimmed.slice(0, TITLE_PREFIX_LENGTH) + (trimmed.length > TITLE_PREFIX_LENGTH ? '…' : '')
    }
    // Slash commands (/permission, /plan, ...) bypass model routing entirely.
    let model: string
    let effort: string | undefined
    if (trimmed.startsWith('/')) {
      model = labelFor('command')
    } else if (this.modelChoice !== 'auto') {
      model = this.modelChoice
      effort = this.effort
    } else {
      model = resolveModelId(this.routeMode, trimmed, st.lastTurnFailed, cfg)
      effort = undefined // router picks the per-model effort
    }
    const turnId = st.turnSeq++
    const turn: ChatTurn = { id: turnId, items: [], status: 'running', model }
    st.turns.push(turn)
    st.pendingTurnId = turnId
    st.currentTurnId = undefined
    st.currentStep = -1
    st.stepTextItemId = undefined
    st.pendingTools.clear()

    const userItem: ChatItem = { kind: 'text', id: `i${st.itemSeq++}`, role: 'user', text: trimmed }
    turn.items.push(userItem)
    this.emit({ type: 'itemAdd', sessionId: st.sessionId, turnId, item: userItem })
    this.emit({ type: 'turnStatus', sessionId: st.sessionId, turnId, status: 'running', model: labelFor(model) })
    this.setRunning(st, true)
    this.emitState()

    try {
      if (trimmed.startsWith('/')) {
        // Slash command: executed through the host command registry, never the
        // model. The command path emits no turn events, so finish the turn here.
        turn.model = '命令'
        this.emit({ type: 'turnStatus', sessionId: st.sessionId, turnId, status: 'running', model: '命令' })
        const result = await this.client.executeCommand(st.sessionId, trimmed)
        const text = result.result?.text
        if (text !== undefined && text !== '') {
          const item: ChatItem = { kind: 'text', id: `i${st.itemSeq++}`, role: 'assistant', text }
          turn.items.push(item)
          this.emit({ type: 'itemAdd', sessionId: st.sessionId, turnId, item })
        }
        turn.status = result.result?.kind === 'error' ? 'error' : 'done'
        if (turn.status === 'error') turn.errorMessage = text ?? '命令执行失败'
        st.currentTurnId = undefined
        st.pendingTurnId = undefined
        this.setRunning(st, false)
        this.emit({ type: 'turnStatus', sessionId: st.sessionId, turnId, status: turn.status, model: '命令', errorMessage: turn.errorMessage })
        this.emitState()
      } else {
        const selected = await this.selectModelWithFallback(model, cfg.provider, effort)
        turn.model = selected.model
        this.emit({ type: 'turnStatus', sessionId: st.sessionId, turnId, status: 'running', model: labelFor(selected.model) })
        await this.client.prompt(st.sessionId, trimmed)
      }
    } catch (error) {
      turn.status = 'error'
      turn.errorMessage = errorMessage(error)
      st.lastTurnFailed = true
      this.setRunning(st, false)
      st.currentTurnId = undefined
      st.pendingTurnId = undefined
      this.emit({ type: 'turnStatus', sessionId: st.sessionId, turnId, status: 'error', model: labelFor(turn.model), errorMessage: turn.errorMessage })
      this.emit({ type: 'toast', kind: 'error', text: `发送失败：${turn.errorMessage}` })
      this.emitState()
      return
    }
  }

  private async selectModelWithFallback(model: string, provider: string, effortOverride?: string): Promise<{ model: string }> {
    const st = this.active()
    const cfg = getDshConfig()
    if (st === undefined) return { model }
    // The routable catalog (session.models) is authoritative: pick a target the
    // provider actually serves, falling back proMax → pro → flash.
    let target = model
    const catalog = await this.ensureCatalog(st)
    if (catalog !== undefined && !catalog.has(target)) {
      const fallback = target === cfg.models.proMax && catalog.has(cfg.models.pro)
        ? cfg.models.pro
        : (catalog.has(cfg.models.flash) ? cfg.models.flash : undefined)
      if (fallback !== undefined) {
        this.emit({ type: 'toast', kind: 'warn', text: `${target} 不在可用模型列表（${[...catalog].join(', ')}），已回退到 ${fallback}` })
        target = fallback
      }
    }
    const effort = effortOverride ?? effortFor(target, cfg)
    try {
      await this.client.selectModel(st.sessionId, provider, target, effort)
      return { model: target }
    } catch (error) {
      if (error instanceof DshRpcError && error.code === 'model-unavailable') {
        const fallback = target === cfg.models.proMax ? cfg.models.pro : cfg.models.flash
        await this.client.selectModel(st.sessionId, provider, fallback, effortFor(fallback, cfg))
        this.emit({ type: 'toast', kind: 'warn', text: `${target} 不可用，已回退到 ${fallback}` })
        return { model: fallback }
      }
      throw error
    }
  }

  /** Load the routable model catalog into {@link catalogModels}. */
  private async refreshCatalog(): Promise<void> {
    const st = this.active()
    if (st === undefined) return
    try {
      const { groups } = await this.client.models(st.sessionId)
      const seen = new Set<string>()
      const models: string[] = []
      for (const g of groups) {
        for (const m of g.models) {
          if (!seen.has(m.id)) {
            seen.add(m.id)
            models.push(m.id)
          }
        }
      }
      this.catalogModels = models
    } catch {
      // keep previous catalog
    }
  }

  /**
   * Refresh the permission preset of one session from its projections.
   * @param sessionId - target session; omitted = controller-active session.
   */
  private async refreshPermission(sessionId?: string): Promise<void> {
    try {
      const { items } = await this.client.listSessions()
      const targetId = sessionId !== undefined ? sessionId : this.activeSessionId
      const st = targetId !== undefined ? this.sessions.get(targetId) : undefined
      if (st === undefined) return
      const mine = items.find((item) => item.sessionId === st.sessionId)
      const proj = (mine as { projections?: { values?: Record<string, unknown> } } | undefined)?.projections
      const perm = proj?.values?.permissions as { currentValue?: string; options?: { value?: string }[] } | undefined
      if (typeof perm?.currentValue === 'string' && perm.currentValue !== '') {
        st.permission = perm.currentValue
      }
      if (Array.isArray(perm?.options) && perm.options.length > 0) {
        this.permissionOptions = perm.options.map((o) => String(o.value ?? '')).filter((v) => v !== '')
      }
    } catch {
      // non-fatal
    }
  }

  /** Set the model selection: 'auto' (router) or an explicit catalog model id. */
  async setModelChoice(model: string): Promise<void> {
    this.modelChoice = model
    await this.ctx.globalState.update('dsh.modelChoice', model)
    this.emit({ type: 'toast', kind: 'info', text: model === 'auto' ? '模型：自动路由' : `模型：${model}` })
    this.emitState()
  }

  /** Set the reasoning effort (off | high | max) for manually chosen models. */
  async setEffort(effort: string): Promise<void> {
    if (!['off', 'high', 'max'].includes(effort)) return
    this.effort = effort
    await this.ctx.globalState.update('dsh.effort', effort)
    this.emit({ type: 'toast', kind: 'info', text: `思考强度：${effort}` })
    this.emitState()
  }

  /** Switch the session permission preset to an explicit one. */
  async setPermission(preset: string, sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    if (!this.permissionOptions.includes(preset)) {
      this.emit({ type: 'toast', kind: 'warn', text: `未知权限模式：${preset}` })
      return
    }
    await this.runPermissionCommand(st.sessionId, preset)
  }

  /** Cycle the session permission preset (read-only → workspace-write → full access). */
  async cyclePermission(sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    // The cached value may be stale (or belong to another session's run) —
    // always re-read THIS session's projection before cycling.
    await this.refreshPermission(st.sessionId)
    const idx = this.permissionOptions.indexOf(st.permission)
    const next = this.permissionOptions[(idx + 1) % this.permissionOptions.length]
    if (next === undefined) return
    await this.runPermissionCommand(st.sessionId, next)
  }

  private async runPermissionCommand(sessionId: string, preset: string): Promise<void> {
    try {
      const result = await this.client.executeCommand(sessionId, `/permission ${preset}`)
      const text = result.result?.text
      if (text !== undefined && text !== '') {
        this.emit({ type: 'toast', kind: 'info', text: `权限：${text}` })
      }
    } catch (error) {
      this.emit({ type: 'toast', kind: 'warn', text: `权限切换失败：${errorMessage(error)}` })
    }
    // Refresh the badge from the projections. The projection write lags the
    // command a little, so poll a couple of times. Must read THIS session's
    // projection (windows are bound to sessions independently of the
    // controller-level active tab).
    const st = this.sessions.get(sessionId)
    for (const delay of [800, 1200]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const before = st?.permission ?? ''
      await this.refreshPermission(sessionId)
      if ((st?.permission ?? '') !== before) break
    }
    this.emitState()
  }

  private async ensureCatalog(st: SessionState): Promise<Set<string> | undefined> {
    try {
      const { groups } = await this.client.models(st.sessionId)
      const set = new Set<string>()
      for (const g of groups) for (const m of g.models) set.add(m.id)
      return set
    } catch {
      return undefined
    }
  }

  async cancel(sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    try {
      await this.client.cancel(st.sessionId)
    } catch (error) {
      this.emit({ type: 'toast', kind: 'warn', text: `取消失败：${errorMessage(error)}` })
    }
  }

  async setMode(mode: RouteMode): Promise<void> {
    this.routeMode = mode
    await this.ctx.globalState.update(ROUTE_MODE_KEY, mode)
    this.emit({ type: 'mode', mode })
    this.emit({ type: 'toast', kind: 'info', text: `模型路由：${routeModeLabel(mode)}` })
    this.emitState()
  }

  /** Create a fresh DSH session and make it the active tab. Returns its id. */
  async newSession(): Promise<string | undefined> {
    if (this.cwd === undefined) return undefined
    try {
      const created = await this.client.createSession({ cwd: this.cwd, agentPreset: getDshConfig().agentPreset })
      const st = newSessionState(created.sessionId, true)
      this.sessions.set(st.sessionId, st)
      this.activeSessionId = st.sessionId
      await this.refreshPermission(st.sessionId)
      this.emitState()
      this.emit({ type: 'toast', kind: 'info', text: '已新建会话' })
      return created.sessionId
    } catch (error) {
      this.emit({ type: 'toast', kind: 'error', text: `新建会话失败：${errorMessage(error)}` })
      return undefined
    }
  }

  /**
   * Switch the active tab to another session. If it is not already in memory
   * (e.g. picked from history), load its turns from the DSH instance first.
   */
  async switchSession(sessionId: string): Promise<void> {
    if (sessionId === this.activeSessionId) return
    let st = this.sessions.get(sessionId)
    if (st === undefined) {
      try {
        const page = await this.client.history(sessionId, undefined, 300)
        st = newSessionState(sessionId, true)
        const rebuilt = rebuildTurns(page.events.map((entry) => entry.event))
        if (rebuilt.length > 0) {
          st.turns = rebuilt
          st.turnSeq = Math.max(0, ...rebuilt.map((t) => t.id)) + 1
          st.lastTurnFailed = rebuilt[rebuilt.length - 1]?.status === 'error'
        }
        this.sessions.set(sessionId, st)
      } catch (error) {
        this.emit({ type: 'toast', kind: 'error', text: `加载会话失败：${errorMessage(error)}` })
        return
      }
    }
    this.activeSessionId = sessionId
    await this.refreshPermission(sessionId)
    this.emitState()
  }

  /** Sessions of this workspace available in the DSH instance (history picker). */
  async listHistorySessions(): Promise<ChatSessionMeta[]> {
    if (this.cwd === undefined) return []
    try {
      const { items } = await this.client.listSessions()
      const norm = normalizePath(this.cwd)
      return items
        .filter((item) => item.cwd !== undefined && normalizePath(item.cwd) === norm)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_HISTORY_TITLES)
        .map((item) => ({
          sessionId: item.sessionId,
          title: sessionTitle(item) || '（未命名会话）',
          running: item.running,
          persisted: true,
        }))
    } catch {
      return []
    }
  }

  clearChat(sessionId?: string): void {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    st.turns = []
    st.turnSeq = 0
    st.itemSeq = 0
    st.currentTurnId = undefined
    st.pendingTurnId = undefined
    this.emitState()
  }

  /** Send from outside the webview (e.g. context-menu commands). */
  async sendExternal(text: string): Promise<void> {
    const st = this.active()
    if (st?.running) {
      this.emit({ type: 'toast', kind: 'warn', text: 'Agent 正在运行，请等待本轮完成后再发送' })
      return
    }
    await this.send(text)
  }

  /** Answer a pending agent question (all questions of one ask() as a batch). */
  async answerQuestion(rpcId: string, answers: QuestionAnswer[], sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    const { accepted, reason } = await this.client.respond(rpcId, true, {
      sessionId: st.sessionId,
      answer: { answers },
    })
    if (!accepted) {
      this.emit({ type: 'toast', kind: 'warn', text: `回答未被接受（${reason ?? 'unknown'}），可能已超时` })
      return
    }
    this.emit({ type: 'questionResolved', sessionId: st.sessionId, rpcId, outcome: 'answered' })
  }

  /** Cancel a pending agent question. */
  async cancelQuestion(rpcId: string, sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    const { accepted } = await this.client.respond(rpcId, false, undefined)
    if (!accepted) return
    this.emit({ type: 'questionResolved', sessionId: st.sessionId, rpcId, outcome: 'cancelled' })
  }

  // ---- event streams ----

  private onMuxFrame(frame: MuxFrame, rpcId: string): void {
    if (frame.type === 'stream/error') {
      this.emit({ type: 'toast', kind: 'error', text: `事件流错误：${frame.error.message}` })
      return
    }
    if (frame.type === 'question/requested') {
      const questions: QuestionItem[] = (frame.questions ?? []).map((q) => ({
        id: q.id,
        question: q.question,
        ...(q.detail === undefined ? {} : { detail: q.detail }),
        ...(q.header === undefined ? {} : { header: q.header }),
        ...(q.options === undefined ? {} : { options: q.options }),
        ...(q.multiSelect === undefined ? {} : { multiSelect: q.multiSelect }),
      }))
      this.emit({ type: 'question', sessionId: frame.sessionId, rpcId, questions })
      return
    }
    if (frame.type === 'question/resolved') {
      this.emit({ type: 'questionResolved', sessionId: frame.sessionId, rpcId: frame.questionRpcId, outcome: frame.outcome })
      return
    }
    if (frame.type !== 'session/event') return
    const st = this.sessions.get(frame.sessionId)
    if (st === undefined) return
    this.onSessionEvent(st, frame.event)
  }

  private onHostFrame(frame: HostFrame): void {
    if (frame.type === 'host/session-status' && !frame.running) {
      const st = this.sessions.get(frame.sessionId)
      if (st !== undefined) this.finishTurnIfRunning(st)
    }
  }

  private onSessionEvent(st: SessionState, event: SessionEvent): void {
    // DSH numbers turns from 1, our local ids are a separate sequence. The
    // first event of a fresh run carries the DSH turn number — adopt it as the
    // turn id so subsequent events match.
    const data = event.data as { turn?: number } | null
    this.adoptTurnIfNeeded(st, typeof data?.turn === 'number' ? data.turn : undefined)
    switch (event.type) {
      case 'assistant/chunk':
        this.onChunk(st, event.data as AssistantChunkData)
        break
      case 'assistant/message':
        this.onAssistantMessage(st, event.data as AssistantMessageData)
        break
      case 'tool/call':
        this.onToolCall(st, event.data as ToolCallData)
        break
      case 'tool/result':
        this.onToolResult(st, event.data as ToolResultData)
        break
      case 'turn/end':
        this.onTurnEnd(st, event.data as TurnEndData)
        break
      case 'user/message':
        this.onUserMessage(st, event.data as UserMessageData)
        break
      case 'session/title': {
        const t = (event.data as { title?: unknown } | null)?.title
        if (typeof t === 'string' && t !== '') {
          st.title = t.slice(0, 60)
          this.emitState()
        }
        break
      }
      default:
        break
    }
  }

  private onChunk(st: SessionState, data: AssistantChunkData): void {
    const turn = this.currentTurn(st)
    if (turn === undefined || data.turn !== turn.id) return
    const chunk = data.chunk
    if (chunk.type === 'text-delta') {
      const item = this.stepTextItem(st, turn, data.step)
      item.text += chunk.text
      this.schedulePatch(st, turn.id, item.id, { text: item.text })
    } else if (chunk.type === 'reasoning-delta') {
      const item = this.stepTextItem(st, turn, data.step)
      item.reasoning = (item.reasoning ?? '') + chunk.text
      this.schedulePatch(st, turn.id, item.id, { reasoning: item.reasoning })
    }
  }

  private onAssistantMessage(st: SessionState, data: AssistantMessageData): void {
    const turn = this.currentTurn(st)
    if (turn === undefined || data.turn !== turn.id) return
    const text = textOf(data.message.content)
    const reasoning = reasoningOf(data.message.content)
    const item = this.stepTextItem(st, turn, data.step, true)
    if (item.text === '' || item.text !== text) {
      item.text = text
      this.schedulePatch(st, turn.id, item.id, { text })
    }
    if (reasoning !== '') {
      item.reasoning = reasoning
      this.schedulePatch(st, turn.id, item.id, { reasoning })
    }
  }

  private onToolCall(st: SessionState, data: ToolCallData): void {
    const turn = this.currentTurn(st)
    if (turn === undefined || data.turn !== turn.id) return
    const item: ChatItem = {
      kind: 'tool',
      id: `i${st.itemSeq++}`,
      callId: data.callId,
      name: data.name,
      args: data.arguments,
      state: 'running',
    }
    turn.items.push(item)
    st.pendingTools.set(data.callId, item.id)
    this.emit({ type: 'itemAdd', sessionId: st.sessionId, turnId: turn.id, item })
  }

  private onToolResult(st: SessionState, data: ToolResultData): void {
    const turn = this.currentTurn(st)
    if (turn === undefined || data.turn !== turn.id) return
    const callId = toolResultCallId(data)
    if (callId === undefined) return
    const itemId = st.pendingTools.get(callId)
    if (itemId === undefined) return
    st.pendingTools.delete(callId)
    const item = turn.items.find((it) => it.id === itemId)
    if (item === undefined || item.kind !== 'tool') return
    item.state = data.error !== undefined ? 'error' : 'done'
    item.isError = data.error !== undefined
    const resultText = textOf(data.message?.content ?? [])
    item.resultText = truncate(resultText, RESULT_TRUNCATE)
    this.schedulePatch(st, turn.id, item.id, { state: item.state, isError: item.isError, resultText: item.resultText })
  }

  private onTurnEnd(st: SessionState, data: TurnEndData): void {
    const turn = this.currentTurn(st)
    if (turn === undefined || data.turn !== turn.id) return
    const kind = data.reason?.kind ?? 'completed'
    turn.status = mapTurnStatus(kind)
    if (kind === 'error') {
      turn.errorMessage = String((data.reason.error as { message?: string } | undefined)?.message ?? '')
    }
    st.lastTurnFailed = kind === 'error'
    st.currentTurnId = undefined
    this.setRunning(st, false)
    this.emit({ type: 'turnStatus', sessionId: st.sessionId, turnId: turn.id, status: turn.status, model: labelFor(turn.model), errorMessage: turn.errorMessage })
    this.emitState()
  }

  private onUserMessage(st: SessionState, data: UserMessageData): void {
    // Only surface direct user prompts; skip synthetic agent-injected context
    // (file-change notices, skill content, goal rounds, ...). Direct prompts
    // carry source.kind 'user' (or 'human' on some paths); everything else is
    // skipped.
    const source = data.source?.kind
    if (source !== undefined && source !== 'user' && source !== 'human') return
    if (st.pendingTurnId === undefined && st.currentTurnId === undefined) return
    const text = textOf(data.content ?? [])
    if (text === '') return
    const turn = this.currentTurn(st) ?? st.turns.find((t) => t.id === st.pendingTurnId)
    if (turn === undefined) return
    // send() already renders the local prompt as a user item; skip the mux
    // echo of the same message so it is not displayed twice.
    if (turn.items.some((it) => it.kind === 'text' && it.role === 'user' && it.text === text)) return
    const item: ChatItem = { kind: 'text', id: `i${st.itemSeq++}`, role: 'user', text }
    turn.items.push(item)
    this.emit({ type: 'itemAdd', sessionId: st.sessionId, turnId: turn.id, item })
  }

  private active(): SessionState | undefined {
    if (this.activeSessionId === undefined) return undefined
    return this.sessions.get(this.activeSessionId)
  }

  private currentTurn(st: SessionState): ChatTurn | undefined {
    if (st.currentTurnId === undefined) return undefined
    return st.turns.find((t) => t.id === st.currentTurnId)
  }

  /**
   * Rekey the freshly-created local turn to the DSH turn number carried by the
   * first event of the run, so event matching (`data.turn === turn.id`) works.
   */
  private adoptTurnIfNeeded(st: SessionState, dshTurn: number | undefined): void {
    if (st.pendingTurnId === undefined || dshTurn === undefined) return
    const turn = st.turns.find((t) => t.id === st.pendingTurnId)
    if (turn === undefined) return
    turn.id = dshTurn
    st.pendingTurnId = undefined
    st.currentTurnId = dshTurn
    // Re-emit the full state so the webview rekeys the turn container.
    this.emitState()
  }

  /** Get-or-create the streaming text item for the current step. */
  private stepTextItem(st: SessionState, turn: ChatTurn, step: number, forceCreate = false): ChatItem & { kind: 'text' } {
    if (st.currentStep !== step || st.stepTextItemId === undefined) {
      // New step → new text item.
      const item: ChatItem = { kind: 'text', id: `i${st.itemSeq++}`, role: 'assistant', text: '' }
      turn.items.push(item)
      st.stepTextItemId = item.id
      st.currentStep = step
      this.emit({ type: 'itemAdd', sessionId: st.sessionId, turnId: turn.id, item })
      return item as ChatItem & { kind: 'text' }
    }
    const item = turn.items.find((it) => it.id === st.stepTextItemId)
    if (item !== undefined && item.kind === 'text') return item
    if (!forceCreate) {
      const created: ChatItem = { kind: 'text', id: `i${st.itemSeq++}`, role: 'assistant', text: '' }
      turn.items.push(created)
      st.stepTextItemId = created.id
      this.emit({ type: 'itemAdd', sessionId: st.sessionId, turnId: turn.id, item: created })
      return created as ChatItem & { kind: 'text' }
    }
    return { kind: 'text', id: `i${st.itemSeq++}`, role: 'assistant', text: '' } as ChatItem & { kind: 'text' }
  }

  private setRunning(st: SessionState, running: boolean): void {
    if (st.running === running) return
    st.running = running
    this.emit({ type: 'runState', sessionId: st.sessionId, running })
  }

  private finishTurnIfRunning(st: SessionState): void {
    if (!st.running) return
    const turnId = st.currentTurnId ?? st.pendingTurnId
    if (turnId === undefined) return
    const wasPending = st.pendingTurnId !== undefined
    const sessionId = st.sessionId
    // The host idle flip usually lands just before the turn's own turn/end
    // event (which carries the authoritative reason: aborted/error/completed).
    // Defer the cleanup + fallback so turn/end can run its normal path first.
    setTimeout(() => {
      const cur = this.sessions.get(sessionId)
      if (cur === undefined) return
      cur.currentTurnId = undefined
      cur.pendingTurnId = undefined
      const turn = cur.turns.find((t) => t.id === turnId)
      if (turn !== undefined && turn.status === 'running') {
        turn.status = 'done'
        this.emit({ type: 'turnStatus', sessionId, turnId: turn.id, status: 'done', model: labelFor(turn.model) })
      }
      if (wasPending) this.emitState()
    }, 2500)
    this.setRunning(st, false)
  }

  // ---- emit machinery ----

  private emit(event: ControllerEvent): void {
    if (this.disposed) return
    for (const cb of this.listeners) cb(event)
  }

  private schedulePatch(st: SessionState, turnId: number, itemId: string, patch: Record<string, unknown>): void {
    const key = `${st.sessionId}:${turnId}:${itemId}`
    const existing = this.pendingPatches.get(key)
    if (existing !== undefined) {
      existing.patch = { ...existing.patch, ...patch }
      return
    }
    this.pendingPatches.set(key, { sessionId: st.sessionId, turnId, itemId, patch })
    if (this.emitTimer === null) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null
        const entries = [...this.pendingPatches.values()]
        this.pendingPatches.clear()
        for (const entry of entries) {
          this.emit({ type: 'itemUpdate', sessionId: entry.sessionId, turnId: entry.turnId, itemId: entry.itemId, patch: entry.patch })
        }
      }, 60)
    }
  }

  private emitState(): void {
    this.emit({ type: 'state', snapshot: this.snapshot() })
  }

  /**
   * Snapshot for one window: its active session's turns. The returned
   * `activeSessionId` is the session this snapshot speaks for, so each window
   * keeps an independent activation.
   */
  snapshotFor(sessionId?: string): ChatSnapshot {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    const cfg = getDshConfig()
    const sessions: ChatSessionMeta[] = [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      running: s.running,
      persisted: s.persisted,
    }))
    return {
      activeSessionId: st?.sessionId ?? '',
      cwd: this.cwd ?? '',
      sessions,
      turns: st?.turns ?? [],
      routeMode: this.routeMode,
      connected: this.client.connected,
      baseUrl: this.client.baseUrl,
      running: st?.running ?? false,
      escalationHint: (st?.lastTurnFailed ?? false) && this.routeMode === 'auto',
      availableModels: this.catalogModels,
      modelChoice: this.modelChoice,
      effort: this.effort,
      permission: st?.permission ?? '',
      permissionOptions: this.permissionOptions,
    }
  }

  /**
   * Make sure a session is in memory (loads its turns from DSH when needed).
   * Returns the session state. Does not change any window's activation.
   */
  async ensureSessionLoaded(sessionId: string): Promise<boolean> {
    let st = this.sessions.get(sessionId)
    if (st !== undefined) {
      // In memory but its permission may never have been read (e.g. sessions
      // loaded before this window opened). Fill it in so the badge is right.
      if (st.permission === '') await this.refreshPermission(sessionId)
      return true
    }
    try {
      const page = await this.client.history(sessionId, undefined, 300)
      st = newSessionState(sessionId, true)
      const rebuilt = rebuildTurns(page.events.map((entry) => entry.event))
      if (rebuilt.length > 0) {
        st.turns = rebuilt
        st.turnSeq = Math.max(0, ...rebuilt.map((t) => t.id)) + 1
        st.lastTurnFailed = rebuilt[rebuilt.length - 1]?.status === 'error'
      }
      this.sessions.set(sessionId, st)
      await this.refreshPermission(sessionId)
      return true
    } catch {
      return false
    }
  }

  /** Display title of one session (for editor window tab titles). */
  getSessionTitle(sessionId: string): string {
    return this.sessions.get(sessionId)?.title ?? ''
  }

  private snapshot(): ChatSnapshot {
    return this.snapshotFor(undefined)
  }
}

// ---- helpers ----

function sessionTitle(item: SessionSummary): string {
  const proj = (item as { projections?: { values?: Record<string, unknown> } }).projections
  const title = proj?.values?.title
  if (typeof title === 'string' && title !== '') return title.slice(0, 60)
  return ''
}

function resolveCwd(cfg: ReturnType<typeof getDshConfig>): string {
  if (cfg.workspacePath.trim() !== '') return path.resolve(cfg.workspacePath.trim())
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder !== undefined) return folder.uri.fsPath
  return os.homedir()
}

function normalizePath(p: string): string {
  return path.normalize(p).toLowerCase()
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function reasoningOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: 'reasoning'; text: string } => b.type === 'reasoning')
    .map((b) => b.text)
    .join('')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(已截断)`
}

function mapTurnStatus(kind: string): ChatTurn['status'] {
  switch (kind) {
    case 'completed': return 'done'
    case 'aborted': return 'aborted'
    case 'error': return 'error'
    case 'max-tokens': return 'max-tokens'
    case 'blocked': return 'blocked'
    case 'interrupted': return 'interrupted'
    default: return 'done'
  }
}

function labelFor(model: string): string {
  return model
}

function effortFor(model: string, cfg: ReturnType<typeof getDshConfig>): string | undefined {
  if (model === cfg.models.proMax) return cfg.reasoningEfforts.proMax
  if (model === cfg.models.pro) return cfg.reasoningEfforts.pro
  return cfg.reasoningEfforts.flash
}

function toolResultCallId(data: ToolResultData): string | undefined {
  const source = data.message?.source
  if (source?.callId !== undefined) return source.callId
  const block = data.message?.content?.[0]
  if (block?.type === 'tool-result') return block.toolCallId
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rebuildTurns(events: SessionEvent[]): ChatTurn[] {
  const turns = new Map<number, ChatTurn>()
  const order: number[] = []
  const pendingToolResult = new Map<string, { state: 'done' | 'error'; resultText?: string; isError?: boolean }>()
  let fallbackId = 1000000
  let lastModel: string | undefined
  // user/message events carry no turn number; buffer direct-human ones and
  // attach them to the next turn that opens (they precede their turn in the log).
  let pendingUserItems: { id: string; text: string }[] = []

  const turnFor = (turnNum: number | undefined): ChatTurn => {
    const id = turnNum ?? fallbackId++
    let turn = turns.get(id)
    if (turn === undefined) {
      turn = { id, items: [], status: 'done', model: lastModel ?? 'auto' }
      if (pendingUserItems.length > 0 && turnNum !== undefined) {
        for (const u of pendingUserItems) {
          turn.items.push({ kind: 'text', id: u.id, role: 'user', text: u.text })
        }
        pendingUserItems = []
      }
      turns.set(id, turn)
      order.push(id)
    }
    return turn
  }

  for (const event of events) {
    const data = event.data as Record<string, unknown> | null | undefined
    const turnNum = typeof data?.turn === 'number' ? (data.turn as number) : undefined
    switch (event.type) {
      case 'request/context': {
        const ctx = data as unknown as { provider?: string; model?: string }
        if (typeof ctx.model === 'string' && ctx.model !== '') lastModel = ctx.model
        break
      }
      case 'user/message': {
        // user/message data is the UserMessage itself (no `message` wrapper).
        const d = data as unknown as UserMessageData
        const source = d.source?.kind
        if (source !== undefined && source !== 'user' && source !== 'human') break
        const text = textOf(d.content ?? [])
        if (text === '') break
        pendingUserItems.push({ id: `h${event.seq}`, text })
        break
      }
      case 'assistant/message': {
        const d = data as unknown as AssistantMessageData
        const turn = turnFor(turnNum)
        turn.items.push({
          kind: 'text',
          id: `h${event.seq}`,
          role: 'assistant',
          text: textOf(d.message?.content ?? []),
          reasoning: reasoningOf(d.message?.content ?? []) || undefined,
        })
        break
      }
      case 'tool/call': {
        const d = data as unknown as ToolCallData
        const turn = turnFor(turnNum)
        turn.items.push({
          kind: 'tool',
          id: `h${event.seq}`,
          callId: d.callId,
          name: d.name,
          args: d.arguments,
          state: 'running',
        })
        break
      }
      case 'tool/result': {
        const d = data as unknown as ToolResultData
        const turn = turnFor(turnNum)
        const callId = toolResultCallId(d)
        if (callId !== undefined) {
          const item = turn.items.find(
            (it): it is ChatItem & { kind: 'tool' } => it.kind === 'tool' && it.callId === callId,
          )
          if (item !== undefined) {
            item.state = d.error !== undefined ? 'error' : 'done'
            item.isError = d.error !== undefined
            item.resultText = truncate(textOf(d.message?.content ?? []), RESULT_TRUNCATE)
          } else {
            pendingToolResult.set(callId, {
              state: d.error !== undefined ? 'error' : 'done',
              resultText: truncate(textOf(d.message?.content ?? []), RESULT_TRUNCATE),
              isError: d.error !== undefined,
            })
          }
        }
        break
      }
      case 'turn/end': {
        const d = data as unknown as TurnEndData
        const turn = turnFor(turnNum ?? d.turn)
        turn.status = mapTurnStatus(d.reason?.kind ?? 'completed')
        if (d.reason?.kind === 'error') {
          turn.errorMessage = String((d.reason.error as { message?: string } | undefined)?.message ?? '')
        }
        break
      }
      default:
        break
    }
  }

  // Attach orphan tool results (tool/result arrived before tool/call in page).
  for (const [callId, result] of pendingToolResult) {
    for (const turn of turns.values()) {
      const item = turn.items.find((it): it is ChatItem & { kind: 'tool' } => it.kind === 'tool' && it.callId === callId)
      if (item !== undefined) {
        item.state = result.state
        item.isError = result.isError
        item.resultText = result.resultText
        break
      }
    }
  }

  // Orphan tool/call without result stays 'running' → mark done with a note.
  for (const turn of turns.values()) {
    for (const item of turn.items) {
      if (item.kind === 'tool' && item.state === 'running') item.state = 'done'
    }
  }

  // User messages never followed by a turn land in a fallback turn.
  if (pendingUserItems.length > 0) {
    const fallback: ChatTurn = { id: fallbackId++, items: [], status: 'done', model: 'auto' }
    for (const u of pendingUserItems) {
      fallback.items.push({ kind: 'text', id: u.id, role: 'user', text: u.text })
    }
    turns.set(fallback.id, fallback)
    order.push(fallback.id)
  }

  return order.map((id) => turns.get(id)!)
}
