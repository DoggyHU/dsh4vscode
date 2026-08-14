/**
 * ChatPanel: editor-area DSH windows (OpenCode-style). Every window is a full
 * chat workspace of its own: session tabs, new-session, history, model routing,
 * question cards. Windows are independent — each keeps its own active session,
 * and new windows always get a NEW session.
 */
import * as vscode from 'vscode'
import { ChatController } from '../dsh/controller.js'
import { getDshConfig } from '../dsh/config.js'
import type { RouteMode } from '../dsh/types.js'

/** One editor window. */
interface Endpoint {
  activeSessionId: string
  post(message: unknown): void
  panel: vscode.WebviewPanel
  disposables: vscode.Disposable[]
}

export class ChatPanel implements vscode.Disposable {
  private windows = new Map<string, Endpoint>() // key: window id
  private windowSeq = 0
  private controllerDisposable: (() => void) | undefined

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly controller: ChatController,
  ) {}

  /** Open a new independent chat window (always backed by a NEW session). */
  async newWindow(): Promise<void> {
    const sessionId = await this.controller.newSession()
    if (sessionId === undefined) return
    this.openSessionWindow(sessionId)
  }

  /** Open an editor window bound to an existing session (continue it). */
  async openSessionWindow(sessionId: string): Promise<void> {
    // Reuse an open window already bound to this session.
    for (const ep of this.windows.values()) {
      if (ep.activeSessionId === sessionId) {
        ep.panel.reveal()
        return
      }
    }
    await this.controller.ensureSessionLoaded(sessionId)
    // Refresh the catalog AND this session's current selection so the picker
    // matches the DSH Web UI (models picked there / providers added after the
    // extension started all show up).
    await this.controller.refreshCatalog(sessionId)
    const title = this.controller.getSessionTitle(sessionId) || 'DSH Chat'
    const panel = vscode.window.createWebviewPanel(
      'dshChatWindow',
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    )
    // Whale icon on the editor tab: light variant for light themes, the
    // gray-white whale for dark themes.
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg'),
    }
    const windowId = `dsh-window-${++this.windowSeq}`
    const disposables: vscode.Disposable[] = []
    const endpoint: Endpoint = {
      activeSessionId: sessionId,
      post: (message) => { void panel.webview.postMessage(message) },
      panel,
      disposables,
    }
    this.windows.set(windowId, endpoint)
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    }
    panel.webview.html = this.renderHtml(panel.webview, title)

    panel.webview.onDidReceiveMessage((message) => {
      void this.onMessage(endpoint, message)
    }, undefined, disposables)

    panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') {
        this.pushInitial(endpoint)
      }
    }, undefined, disposables)

    disposables.push(panel.onDidDispose(() => {
      this.windows.delete(windowId)
      for (const d of disposables) d.dispose()
    }))

    this.ensureBroadcast()
  }

  // ---- shared plumbing ----

  private ensureBroadcast(): void {
    if (this.controllerDisposable !== undefined) return
    this.controllerDisposable = this.controller.onEvent((event) => {
      for (const ep of this.windows.values()) this.pushToWindow(ep, event)
    })
  }

  private pushToWindow(endpoint: Endpoint, event: Parameters<Parameters<ChatController['onEvent']>[0]>[0]): void {
    if (event.type === 'state') {
      // Each window renders its own active session's turns.
      endpoint.post({ type: 'state', snapshot: this.controller.snapshotFor(endpoint.activeSessionId) })
      const title = this.controller.getSessionTitle(endpoint.activeSessionId)
      if (title !== '' && endpoint.panel.title !== title) endpoint.panel.title = title
      return
    }
    endpoint.post(event)
  }

  private pushInitial(endpoint: Endpoint): void {
    const conn = this.controller.getConnectionState()
    endpoint.post({ type: 'state', snapshot: this.controller.snapshotFor(endpoint.activeSessionId) })
    endpoint.post({ type: 'mode', mode: this.controller.getMode() })
    endpoint.post({ type: 'connection', connected: conn.connected, error: conn.error })
    endpoint.post({ type: 'runState', sessionId: endpoint.activeSessionId, running: this.controller.isRunningFor(endpoint.activeSessionId) })
  }

  private async onMessage(endpoint: Endpoint, message: { type: string; [k: string]: unknown }): Promise<void> {
    const sessionId = endpoint.activeSessionId
    switch (message.type) {
      case 'ready':
        break
      case 'send': {
        const raw = String(message.text ?? '')
        if (raw.trim() !== '') {
          const expanded = await expandFileRefs(raw)
          await this.controller.send(expanded, sessionId)
        }
        break
      }
      case 'cancel':
        await this.controller.cancel(sessionId)
        break
      case 'setModelChoice': {
        const model = String(message.model ?? 'auto')
        await this.controller.setModelChoice(model, sessionId)
        break
      }
      case 'setEffort': {
        const effort = String(message.effort ?? 'high')
        await this.controller.setEffort(effort, sessionId)
        break
      }
      case 'refreshCatalog': {
        // Reload the DSH model directory on picker open (Web UI parity).
        await this.controller.refreshCatalog(sessionId)
        endpoint.post({ type: 'state', snapshot: this.controller.snapshotFor(sessionId) })
        break
      }
      case 'cyclePermission':
        await this.controller.cyclePermission(sessionId)
        break
      case 'setPermission': {
        const preset = String(message.preset ?? '')
        if (preset !== '') await this.controller.setPermission(preset, sessionId)
        break
      }
      case 'findFiles': {
        const query = String(message.query ?? '')
        const files = await findWorkspaceFiles(query)
        endpoint.post({ type: 'fileResults', query, files })
        break
      }
      case 'selectMode': {
        const mode = String(message.mode ?? 'auto') as RouteMode
        if (['auto', 'flash', 'pro', 'proMax'].includes(mode)) await this.controller.setMode(mode)
        break
      }
      case 'newSession': {
        // New tab inside THIS window: create a session and activate it here.
        const sid = await this.controller.newSession()
        if (sid !== undefined) {
          endpoint.activeSessionId = sid
          this.pushInitial(endpoint)
        }
        break
      }
      case 'newWindow': {
        // Spawn another independent window from inside this window.
        await this.newWindow()
        break
      }
      case 'switchSession': {
        const target = String(message.sessionId ?? '')
        if (target !== '' && target !== endpoint.activeSessionId) {
          await this.controller.ensureSessionLoaded(target)
          endpoint.activeSessionId = target
          this.pushInitial(endpoint)
        }
        break
      }
      case 'listHistory': {
        const items = await this.controller.listHistorySessions()
        endpoint.post({ type: 'history', items })
        break
      }
      case 'answerQuestion': {
        const rpcId = String(message.rpcId ?? '')
        const answers = Array.isArray(message.answers) ? message.answers as { id: string; selected: string[]; custom?: string }[] : []
        if (rpcId !== '' && answers.length > 0) await this.controller.answerQuestion(rpcId, answers, sessionId)
        break
      }
      case 'cancelQuestion': {
        const rpcId = String(message.rpcId ?? '')
        if (rpcId !== '') await this.controller.cancelQuestion(rpcId, sessionId)
        break
      }
      case 'clear':
        this.controller.clearChat(sessionId)
        break
      case 'reconnect':
        await this.controller.reconnect()
        break
      case 'openFile': {
        const p = String(message.path ?? '')
        if (p !== '') await openInEditor(p)
        break
      }
      case 'openWeb': {
        const cfg = getDshConfig()
        void vscode.env.openExternal(vscode.Uri.parse(cfg.baseUrl))
        break
      }
      case 'openExternal': {
        const url = String(message.url ?? '')
        if (/^https?:\/\//i.test(url)) void vscode.env.openExternal(vscode.Uri.parse(url))
        break
      }
      default:
        break
    }
  }

  private renderHtml(webview: vscode.Webview, title: string): string {
    // Cache-bust: the webview service worker caches media by URL; a version
    // query makes every release fetch fresh assets. In development the package
    // version never changes between edits, so append a per-window timestamp —
    // otherwise the SW keeps serving yesterday's main.js during the dev loop.
    const pkgVersion = String(this.ctx.extension.packageJSON?.version ?? '')
    const version = this.ctx.extensionMode === vscode.ExtensionMode.Development
      ? `${pkgVersion}-${Date.now()}`
      : pkgVersion
    const media = (name: string): vscode.Uri => webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', name).with({ query: `v=${version}` }),
    )
    const styleUri = media('style.css')
    const mainUri = media('main.js')
    const mdUri = media('vendor/markdown-it.min.js')
    const codiconUri = media('vendor/codicon.css')
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <header id="dsh-header">
    <div class="header-row">
      <span id="conn-dot" class="dot pending" title="连接状态"></span>
      <span id="conn-text" class="conn-text">连接中…</span>
      <span class="spacer"></span>
      <button id="btn-history" class="icon-btn" title="历史会话"><span class="codicon codicon-history"></span></button>
      <button id="btn-web" class="icon-btn" title="打开 DSH Web GUI"><span class="codicon codicon-globe"></span></button>
    </div>
    <div id="tab-bar" class="tab-bar">
      <div id="tab-list" class="tab-list"></div>
      <button id="btn-new-tab" class="tab-new" title="新建会话（tab）"><span class="codicon codicon-add"></span></button>
      <button id="btn-new-window" class="tab-new" title="新建独立窗口（可多开分屏）"><span class="codicon codicon-multiple-windows"></span></button>
    </div>
    <div class="header-row">
      <label class="model-label" for="model-select">模型</label>
      <select id="model-select" title="模型（Auto = 自动路由）"></select>
      <label class="model-label" for="effort-select">思考</label>
      <select id="effort-select" title="推理强度（手动选模型时生效）">
        <option value="off">off</option>
        <option value="high">high</option>
        <option value="max">max</option>
      </select>
      <span class="spacer"></span>
      <button id="btn-cancel" class="btn-cancel hidden" title="取消当前运行">停止</button>
    </div>
    <div id="session-bar" class="session-bar" title=""></div>
    <div id="history-pop" class="history-pop hidden">
      <div class="history-title">历史会话</div>
      <div id="history-list" class="history-list"></div>
    </div>
    <div id="question-banner" class="question-banner hidden">
      <div class="question-head">❓ Agent 向你提问</div>
      <div id="question-body" class="question-body"></div>
      <div class="question-actions">
        <button id="btn-question-cancel" class="btn-cancel-q">取消</button>
        <button id="btn-question-submit" class="btn-send">提交回答</button>
      </div>
    </div>
  </header>
  <main id="chat-scroll">
    <div id="chat" class="chat"></div>
    <div id="empty-hint" class="empty-hint">
      <div class="empty-logo">DSH</div>
      <p>DeepSeek Harness 聊天面板</p>
      <p class="empty-sub">规划/架构 → Pro · 杂活 → Flash · 疑难 → Pro Max</p>
    </div>
  </main>
  <footer id="dsh-footer">
    <div id="input-popup" class="input-popup hidden"></div>
    <textarea id="input" rows="1" placeholder="输入消息，Enter 发送。@ 引用文件，/ 斜杠命令，Shift+Enter 换行。"></textarea>
    <div class="footer-row">
      <button id="perm-badge" class="perm-badge" title="点击切换权限模式（read-only → workspace-write → full access）"></button>
      <span id="status-text" class="status-text"></span>
      <span class="spacer"></span>
      <button id="btn-send" class="btn-send" disabled>发送</button>
    </div>
  </footer>
  <div id="toast" class="toast"></div>
  <script src="${mdUri}"></script>
  <script src="${mainUri}"></script>
</body>
</html>`
  }

  dispose(): void {
    this.controllerDisposable?.()
    this.controllerDisposable = undefined
    for (const ep of this.windows.values()) {
      for (const d of ep.disposables) d.dispose()
    }
    this.windows.clear()
  }
}

async function openInEditor(p: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(p)
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc, { preview: false })
  } catch (error) {
    void vscode.window.showErrorMessage(`无法打开文件 ${p}：${error instanceof Error ? error.message : String(error)}`)
  }
}

const FILE_REF_RE = /(^|\s)@([^\s@]+)/g

/**
 * Expand `@path` references in a message into inline file content blocks.
 * Only matches paths that resolve to real files in the workspace.
 */
async function expandFileRefs(text: string): Promise<string> {
  const refs = new Set<string>()
  let match: RegExpExecArray | null
  const re = new RegExp(FILE_REF_RE.source, 'g')
  while ((match = re.exec(text)) !== null) {
    refs.add(match[2])
  }
  if (refs.size === 0) return text
  const blocks: string[] = []
  for (const ref of refs) {
    const fileUri = await resolveWorkspaceFile(ref)
    if (fileUri === undefined) continue
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri)
      const rel = vscode.workspace.asRelativePath(fileUri, false)
      const content = doc.getText()
      const max = 20000
      const snippet = content.length > max ? `${content.slice(0, max)}\n…(文件过长已截断)` : content
      blocks.push(`\n\n<file path="${rel}">\n\`\`\`\n${snippet}\n\`\`\`\n</file>`)
    } catch {
      // unreadable file — leave the reference as text
    }
  }
  if (blocks.length === 0) return text
  return text + blocks.join('')
}

/** Resolve a possibly-relative @reference to a workspace file URI. */
async function resolveWorkspaceFile(ref: string): Promise<vscode.Uri | undefined> {
  const clean = ref.replace(/^\.\//, '').replace(/[,.!?;:)]+$/, '')
  if (clean === '') return undefined
  // Exact relative match first.
  const folders = vscode.workspace.workspaceFolders ?? []
  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, clean)
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (stat.type === vscode.FileType.File) return uri
    } catch {
      // not found — keep looking
    }
  }
  // Fuzzy: unique basename match.
  const pattern = `**/${clean.split('/').pop() ?? clean}`
  const hits = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10)
  if (hits.length === 1) return hits[0]
  if (hits.length > 0) {
    const folder = folders[0]
    if (folder !== undefined) {
      for (const hit of hits) {
        if (hit.fsPath.startsWith(folder.uri.fsPath)) return hit
      }
    }
    return hits[0]
  }
  return undefined
}

/** Find workspace files matching a fuzzy query (for the @ picker). */
async function findWorkspaceFiles(query: string): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? []
  const pattern = '**/*'
  const q = query.trim().toLowerCase()
  try {
    const hits = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 400)
    const ranked = hits
      .map((uri) => vscode.workspace.asRelativePath(uri, false))
      .filter((p) => !p.startsWith('.git/'))
      .filter((p) => q === '' || p.toLowerCase().includes(q))
      .sort((a, b) => a.length - b.length)
      .slice(0, 50)
    return folders.length > 0 ? ranked : []
  } catch {
    return []
  }
}
