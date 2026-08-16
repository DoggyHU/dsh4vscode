/**
 * ChatController: owns multiple DSH sessions for the current workspace — one
 * session per chat tab. Turns the mux/host event streams into renderable chat
 * models per session. Model selection, catalog, and inheritance are DSH's own:
 * this class indexes session.models / session.selectModel, exactly like the
 * Web UI, and keeps no model vocabulary of its own.
 */
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { DshClient } from './client.js'
import { getDshConfig } from './config.js'
import type {
  AssistantChunkData,
  AssistantMessageData,
  CatalogGroup,
  ChatItem,
  ChatSessionMeta,
  ChatSnapshot,
  ChatTurn,
  ContentBlock,
  HostFrame,
  ModelSelection,
  MuxFrame,
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
  currentTurnId: number | undefined
  pendingTurnId: number | undefined
  stepTextItemId: string | undefined
  currentStep: number
  pendingTools: Map<string, string> // callId -> itemId
  /** Current permission preset of THIS session (from its projections). */
  permission: string
  /** DSH's current model selection for THIS session (session.models `current`). */
  modelCurrent?: ModelSelection
  /**
   * High-water mark of DSH turn numbers seen in events. Turn adoption is only
   * allowed above this mark, so a straggler event from a FINISHED turn can
   * never hijack the pending turn's id.
   */
  lastSeenTurn: number
}

function newSessionState(sessionId: string, persisted: boolean, title = '新会话'): SessionState {
  return {
    sessionId,
    title,
    persisted,
    turns: [],
    turnSeq: -1,
    itemSeq: 0,
    running: false,
    currentTurnId: undefined,
    pendingTurnId: undefined,
    stepTextItemId: undefined,
    currentStep: -1,
    pendingTools: new Map(),
    permission: '',
    modelCurrent: undefined,
    lastSeenTurn: -1,
  }
}

export class ChatController implements vscode.Disposable {
  private client: DshClient
  private listeners = new Set<Listener>()
  private sessions = new Map<string, SessionState>()
  private activeSessionId: string | undefined
  private cwd: string | undefined
  /** Provider-grouped model catalog (mirrors the DSH Web UI picker). */
  private catalogGroups: CatalogGroup[] = []
  private permissionOptions: string[] = ['read-only', 'workspace-write', 'danger-full-access']
  private lastError: string | undefined
  private lastConnected = false
  private disposed = false
  private emitTimer: NodeJS.Timeout | null = null
  private pendingPatches = new Map<string, { sessionId: string; turnId: number; itemId: string; patch: Record<string, unknown> }>()

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const cfg = getDshConfig()
    this.client = new DshClient(cfg.baseUrl)
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
    this.applyRebuiltTurns(st, rebuildTurns(page.events.map((entry) => entry.event)))
  }

  /**
   * Adopt a rebuilt turn list into a session. DSH turn numbers are the
   * positive ids; local placeholder ids and orphan-user-message fallback turns
   * are negative. `lastSeenTurn` must reflect only the highest DSH turn number
   * so the next live turn can be adopted above it (never derive it from the
   * placeholder/fallback ids, or adoption would be blocked forever).
   */
  private applyRebuiltTurns(st: SessionState, rebuilt: ChatTurn[]): void {
    if (rebuilt.length === 0) return
    st.turns = rebuilt
    st.lastSeenTurn = Math.max(-1, ...rebuilt.map((t) => (t.id >= 0 ? t.id : -1)))
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
    if (st.title === '新会话' && !trimmed.startsWith('/')) {
      st.title = trimmed.slice(0, TITLE_PREFIX_LENGTH) + (trimmed.length > TITLE_PREFIX_LENGTH ? '…' : '')
    }
    // Slash commands (/permission, /plan, ...) bypass the model entirely.
    // Everything else follows the DSH session's recorded current selection —
    // the exact path the Web UI takes; no plugin-side model decision.
    let model: string
    if (trimmed.startsWith('/')) {
      model = labelFor('command')
    } else {
      if (st.modelCurrent === undefined) await this.refreshCatalog(st.sessionId)
      const sel = st.modelCurrent
      if (sel === undefined) {
        this.emit({ type: 'toast', kind: 'error', text: '无法读取当前模型选择，请重试或切换模型' })
        return
      }
      model = sel.model
    }
    // Local placeholder ids are NEGATIVE so they can never collide with DSH's
    // positive turn numbers: adoption rekeys the placeholder to the real DSH
    // turn number, and `find(t => t.id === pendingTurnId)` stays unambiguous.
    const turnId = st.turnSeq--
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
        const text = result?.result?.text
        if (text !== undefined && text !== '') {
          const item: ChatItem = { kind: 'text', id: `i${st.itemSeq++}`, role: 'assistant', text }
          turn.items.push(item)
          this.emit({ type: 'itemAdd', sessionId: st.sessionId, turnId, item })
        }
        turn.status = result?.result?.kind === 'error' ? 'error' : 'done'
        if (turn.status === 'error') turn.errorMessage = text ?? '命令执行失败'
        st.currentTurnId = undefined
        st.pendingTurnId = undefined
        this.setRunning(st, false)
        this.emit({ type: 'turnStatus', sessionId: st.sessionId, turnId, status: turn.status, model: '命令', errorMessage: turn.errorMessage })
        this.emitState()
      } else {
        // Prompt only — DSH assembles the turn from the session's recorded
        // current selection, exactly like the Web UI.
        await this.client.prompt(st.sessionId, trimmed)
      }
    } catch (error) {
      turn.status = 'error'
      turn.errorMessage = errorMessage(error)
      this.setRunning(st, false)
      st.currentTurnId = undefined
      st.pendingTurnId = undefined
      this.emit({ type: 'turnStatus', sessionId: st.sessionId, turnId, status: 'error', model: labelFor(turn.model), errorMessage: turn.errorMessage })
      this.emit({ type: 'toast', kind: 'error', text: `发送失败：${turn.errorMessage}` })
      this.emitState()
      return
    }
  }

  /**
   * Load the provider-grouped model catalog (same source the DSH Web UI
   * renders) into {@link catalogGroups}, and record the given session's
   * current selection (session.models `current`) — the single fact the Web UI
   * highlights. Public so windows refresh it on open: providers configured
   * after the extension started, and models picked in the Web UI, show up.
   */
  async refreshCatalog(sessionId?: string): Promise<void> {
    const targetId = sessionId !== undefined ? sessionId : this.activeSessionId
    const st = targetId !== undefined ? this.sessions.get(targetId) : undefined
    if (st === undefined) return
    try {
      const value = await this.client.models(st.sessionId)
      this.catalogGroups = value.groups.map((g) => ({
        id: g.id,
        name: g.name,
        models: g.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          efforts: (m.reasoning?.efforts ?? []).map((e) => e.id),
          ...(m.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: m.reasoning.defaultEffort }),
        })),
      }))
      st.modelCurrent = {
        provider: value.current.provider,
        model: value.current.model,
        ...(value.current.reasoningEffort === undefined ? {} : { reasoningEffort: value.current.reasoningEffort }),
      }
    } catch {
      // keep previous catalog / selection
    }
  }

  /** Look up `provider/model` (or a legacy bare model id) in the catalog. */
  private catalogEntry(choice: string): { provider: string; model: string; efforts: string[]; defaultEffort?: string } | undefined {
    if (choice === '') return undefined
    const slash = choice.indexOf('/')
    if (slash > 0) {
      const provider = choice.slice(0, slash)
      const model = choice.slice(slash + 1)
      const group = this.catalogGroups.find((g) => g.id === provider)
      const entry = group?.models.find((m) => m.id === model)
      return entry === undefined
        ? { provider, model, efforts: [], defaultEffort: undefined }
        : { provider, model, efforts: entry.efforts, defaultEffort: entry.defaultEffort }
    }
    // Legacy stored value: bare model id — first matching group wins.
    for (const group of this.catalogGroups) {
      const entry = group.models.find((m) => m.id === choice)
      if (entry !== undefined) {
        return { provider: group.id, model: choice, efforts: entry.efforts, defaultEffort: entry.defaultEffort }
      }
    }
    return undefined
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

  /**
   * Set the model selection, mirroring the Web UI picker exactly: a
   * `provider/model` pick calls session.selectModel with the model's declared
   * default effort. The DSH-side switch ALSO becomes the deployment default —
   * the Web UI's inheritance behavior. Nothing is persisted plugin-side: DSH
   * itself is the memory (per-session current + deployment default).
   * @param choice - `provider/model` (or a legacy bare model id).
   * @param sessionId - the window's session; omitted = controller-active.
   */
  async setModelChoice(choice: string, sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    const entry = this.catalogEntry(choice)
    if (entry === undefined) {
      this.emit({ type: 'toast', kind: 'warn', text: `模型目录中找不到：${choice}` })
      return
    }
    // Web UI parity: switching to a (different) model carries the model's
    // declared default effort; DSH validates effort ids against the adapter.
    const effort = entry.defaultEffort
    try {
      const res = await this.client.selectModel(st.sessionId, entry.provider, entry.model, effort)
      st.modelCurrent = {
        provider: res.selected.provider,
        model: res.selected.model,
        ...(res.selected.reasoningEffort === undefined ? {} : { reasoningEffort: res.selected.reasoningEffort }),
      }
      this.emit({ type: 'toast', kind: 'info', text: `模型：${entry.model}` })
    } catch (error) {
      this.emit({ type: 'toast', kind: 'warn', text: `模型切换失败：${errorMessage(error)}` })
    }
    this.emitState()
  }

  /**
   * Set the reasoning effort of the session's current model. The accepted
   * values are whatever the model declares (the Web UI renders the same list);
   * DSH itself validates the id against the adapter. '' = provider default.
   * @param effort - an effort id declared by the current model, or ''.
   * @param sessionId - the window's session; omitted = controller-active.
   */
  async setEffort(effort: string, sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    const cur = st.modelCurrent
    if (cur === undefined) return
    try {
      const res = await this.client.selectModel(st.sessionId, cur.provider, cur.model, effort === '' ? undefined : effort)
      st.modelCurrent = {
        provider: res.selected.provider,
        model: res.selected.model,
        ...(res.selected.reasoningEffort === undefined ? {} : { reasoningEffort: res.selected.reasoningEffort }),
      }
      this.emit({ type: 'toast', kind: 'info', text: effort === '' ? '思考强度：Provider 默认' : `思考强度：${effort}` })
    } catch (error) {
      this.emit({ type: 'toast', kind: 'warn', text: `思考强度切换失败：${errorMessage(error)}` })
    }
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
      const text = result?.result?.text
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

  async cancel(sessionId?: string): Promise<void> {
    const st = sessionId !== undefined ? this.sessions.get(sessionId) : this.active()
    if (st === undefined) return
    try {
      await this.client.cancel(st.sessionId)
    } catch (error) {
      this.emit({ type: 'toast', kind: 'warn', text: `取消失败：${errorMessage(error)}` })
    }
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
      // Read the new session's current selection: DSH seeds it from the
      // deployment default — the last pick made anywhere (Web UI or plugin)
      // is what this new dialog inherits. Same behavior as the Web UI.
      await this.refreshCatalog(st.sessionId)
      this.emitState()
      this.emit({ type: 'toast', kind: 'info', text: '已新建会话' })
      return created.sessionId
    } catch (error) {
      this.emit({ type: 'toast', kind: 'error', text: `新建会话失败：${errorMessage(error)}` })
      return undefined
    }
  }

  /**
   * Close one session tab (UI only — the DSH session stays and reappears in
   * the history picker). Returns the session id that should become active in
   * its place, or undefined when the closed tab was not the active one.
   */
  async closeTab(sessionId: string): Promise<string | undefined> {
    if (sessionId === undefined || !this.sessions.has(sessionId)) return undefined
    this.sessions.delete(sessionId)
    if (this.activeSessionId !== sessionId) return undefined
    const next = [...this.sessions.keys()].at(-1)
    if (next !== undefined) {
      this.activeSessionId = next
    } else {
      // No tabs left: keep a fresh home tab so the window never goes empty.
      this.activeSessionId = undefined
      await this.newSession()
      return this.activeSessionId
    }
    this.emitState()
    return next
  }

  /** Sessions of this workspace available in the DSH instance (history picker). */
  async listHistorySessions(): Promise<ChatSessionMeta[]> {
    if (this.cwd === undefined) return []
    try {
      const { items } = await this.client.listSessions()
      const norm = normalizePath(this.cwd)
      const sep = path.sep
      return items
        .filter((item) => {
          if (item.cwd === undefined) return false
          const c = normalizePath(item.cwd)
          return c === norm || c.startsWith(norm + sep)
        })
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
    st.turnSeq = -1
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
    // DSH numbers turns from 1; a monotonic high-water mark lets adoption
    // distinguish the pending turn's first event from stragglers of old turns.
    const data = event.data as { turn?: number } | null
    const dshTurn = typeof data?.turn === 'number' ? data.turn : undefined
    this.adoptTurnIfNeeded(st, dshTurn)
    if (dshTurn !== undefined && dshTurn > st.lastSeenTurn) st.lastSeenTurn = dshTurn
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
    // Match by the authoritative DSH turn number, not the `currentTurnId`
    // pointer: the pointer can already be undefined (a host-status idle flip
    // raced ahead, or a later turn has started) while the turn still sits in
    // `st.turns` under its adopted DSH id.
    const turn = st.turns.find((t) => t.id === data.turn)
    if (turn === undefined) return
    const kind = data.reason?.kind ?? 'completed'
    turn.status = mapTurnStatus(kind)
    if (kind === 'error') {
      turn.errorMessage = String((data.reason.error as { message?: string } | undefined)?.message ?? '')
    }
    // Clear run-pointers only if they still reference THIS turn; a newer turn
    // may already own them.
    const isLive = st.currentTurnId === turn.id || st.pendingTurnId === turn.id
    if (st.currentTurnId === turn.id) st.currentTurnId = undefined
    if (st.pendingTurnId === turn.id) st.pendingTurnId = undefined
    if (isLive) this.setRunning(st, false)
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
   *
   * CRITICAL: only adopt a turn number ABOVE the session's high-water mark.
   * Events of an already-finished turn can arrive after the user has sent the
   * next prompt (stream lag, host-status flip race). Without the guard such a
   * straggler would rekey the NEW pending turn to the OLD turn's number, and
   * every subsequent event of the new turn (`data.turn !== turn.id`) would be
   * dropped — the chat shows the message stuck at "进行中" with no content.
   */
  private adoptTurnIfNeeded(st: SessionState, dshTurn: number | undefined): void {
    if (st.pendingTurnId === undefined || dshTurn === undefined) return
    if (dshTurn <= st.lastSeenTurn) return
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
    const turn = st.currentTurnId !== undefined
      ? this.currentTurn(st)
      : (st.pendingTurnId !== undefined ? st.turns.find((t) => t.id === st.pendingTurnId) : undefined)
    if (turn === undefined) return
    const sessionId = st.sessionId
    // The host idle flip usually lands just before the turn's own turn/end
    // event (which carries the authoritative reason: aborted/error/completed).
    // Defer the cleanup + fallback so turn/end can run its normal path first.
    // Capture the turn OBJECT — never just its id — so a later adoption rekey
    // cannot detach the timer from its turn, and only clear run-pointers that
    // still reference THIS turn (a newer turn may have taken them over).
    setTimeout(() => {
      const cur = this.sessions.get(sessionId)
      if (cur === undefined) return
      if (cur.currentTurnId === turn.id) cur.currentTurnId = undefined
      if (cur.pendingTurnId === turn.id) cur.pendingTurnId = undefined
      if (turn.status === 'running') {
        turn.status = 'done'
        this.emit({ type: 'turnStatus', sessionId, turnId: turn.id, status: 'done', model: labelFor(turn.model) })
        this.emitState()
      }
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
      connected: this.client.connected,
      baseUrl: this.client.baseUrl,
      running: st?.running ?? false,
      catalogGroups: this.catalogGroups,
      modelCurrent: st?.modelCurrent,
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
      // In memory but its permission/model selection may never have been read
      // (e.g. sessions loaded before this window opened). Fill them in.
      if (st.permission === '') await this.refreshPermission(sessionId)
      if (st.modelCurrent === undefined) await this.refreshCatalog(sessionId)
      return true
    }
    try {
      const page = await this.client.history(sessionId, undefined, 300)
      st = newSessionState(sessionId, true)
      this.applyRebuiltTurns(st, rebuildTurns(page.events.map((entry) => entry.event)))
      this.sessions.set(sessionId, st)
      await this.refreshPermission(sessionId)
      await this.refreshCatalog(sessionId)
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
  // Fallback (orphan user-message) turns get negative ids so they can never be
  // mistaken for DSH turn numbers when computing the session high-water mark.
  let fallbackId = -1000000
  let lastModel: string | undefined
  // user/message events carry no turn number; buffer direct-human ones and
  // attach them to the next turn that opens (they precede their turn in the log).
  let pendingUserItems: { id: string; text: string }[] = []

  const turnFor = (turnNum: number | undefined): ChatTurn => {
    const id = turnNum ?? fallbackId--
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
    const fallback: ChatTurn = { id: fallbackId--, items: [], status: 'done', model: 'auto' }
    for (const u of pendingUserItems) {
      fallback.items.push({ kind: 'text', id: u.id, role: 'user', text: u.text })
    }
    turns.set(fallback.id, fallback)
    order.push(fallback.id)
  }

  return order.map((id) => turns.get(id)!)
}
