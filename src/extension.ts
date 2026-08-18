/**
 * DSH for VS Code — extension entry.
 */
import * as vscode from 'vscode'
import { ChatController } from './dsh/controller.js'
import { getDshConfig } from './dsh/config.js'
import { ChatPanel } from './webview/panel.js'

let controller: ChatController | undefined
let panel: ChatPanel | undefined
let statusBar: vscode.StatusBarItem | undefined
/** One-shot auto-open guard for this window's lifetime (avoid duplicate windows). */
let autoOpenedOnce = false

export function activate(ctx: vscode.ExtensionContext): void {
  controller = new ChatController(ctx)
  ctx.subscriptions.push(controller)

  panel = new ChatPanel(ctx, controller)
  ctx.subscriptions.push(panel)

  // Status bar entry.
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  statusBar.text = '🐳 DSH'
  statusBar.tooltip = 'DSH Chat：打开聊天窗口'
  statusBar.command = 'dsh.openChat'
  statusBar.show()
  ctx.subscriptions.push(statusBar)

  // Commands.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('dsh.openChat', () => {
      void panel?.newWindow()
    }),
    vscode.commands.registerCommand('dsh.openInEditor', () => {
      const sid = controller?.getActiveSessionId()
      if (sid !== undefined) void panel?.openSessionWindow(sid)
    }),
    vscode.commands.registerCommand('dsh.newWindow', async () => {
      // A new window is a NEW independent session — never a mirror of another.
      await panel?.newWindow()
    }),
    vscode.commands.registerCommand('dsh.newSession', () => {
      void controller?.newSessionWithChoice()
    }),
    vscode.commands.registerCommand('dsh.cancel', () => {
      void controller?.cancel()
    }),
    vscode.commands.registerCommand('dsh.clearChat', () => {
      controller?.clearChat()
    }),
    vscode.commands.registerCommand('dsh.askSelection', () => {
      void askAboutSelection(controller, panel, 'explain')
    }),
    vscode.commands.registerCommand('dsh.fixSelection', () => {
      void askAboutSelection(controller, panel, 'fix')
    }),
    vscode.commands.registerCommand('dsh.reconnect', async () => {
      await controller?.reconnect()
    }),
    vscode.commands.registerCommand('dsh.openDshWeb', () => {
      void vscode.env.openExternal(vscode.Uri.parse(getDshConfig().baseUrl))
    }),
  )

  // Auto-open the chat window (Claude Code / OpenCode parity): after the
  // controller restores the last session, surface it in the editor area so the
  // user doesn't have to press Ctrl+Alt+D. Guarded so it only fires once a real
  // workspace is present and only once per window.
  const maybeAutoOpen = async (): Promise<void> => {
    if (!getDshConfig().autoOpenOnStartup) return
    // Only auto-open once a workspace folder is actually loaded (the controller
    // briefly runs against the homedir fallback before the folder restores).
    if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) return
    if (panel?.hasWindows() ?? false) return
    const sid = controller?.getActiveSessionId()
    if (sid !== undefined) await panel?.openSessionWindow(sid)
  }

  // Kick off session init once a workspace is available, then auto-open.
  void (async () => {
    await controller?.init()
    await maybeAutoOpen()
  })()

  // Re-init when the workspace root changes (or opens late), then auto-open if
  // the first attempt ran before the workspace folder was ready.
  const onFolderChange = (): void => {
    void (async () => {
      await controller?.reconnect()
      await controller?.init()
      await maybeAutoOpen()
    })()
  }
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(onFolderChange))
}

export function deactivate(): void {
  controller?.dispose()
  controller = undefined
}

async function askAboutSelection(
  ctrl: ChatController | undefined,
  panel: ChatPanel | undefined,
  action: 'explain' | 'fix',
): Promise<void> {
  if (ctrl === undefined) return
  const editor = vscode.window.activeTextEditor
  if (editor === undefined) return
  const selection = editor.selection
  if (selection.isEmpty) {
    void vscode.window.showWarningMessage('请先在编辑器中选中代码。')
    return
  }
  const selectedText = editor.document.getText(selection)
  const relPath = vscode.workspace.asRelativePath(editor.document.uri, false)
  const lineRange = `${selection.start.line + 1}-${selection.end.line + 1}`
  const language = editor.document.languageId

  const block = [
    `文件：\`${relPath}\`（第 ${lineRange} 行）`,
    '',
    '```' + language,
    selectedText,
    '```',
  ].join('\n')

  const prompt = action === 'explain'
    ? `请分析并解释以下代码，说明它的作用、关键逻辑和潜在问题：\n\n${block}`
    : `下面的代码存在 bug 或需要修改。请先定位问题，然后**直接修改工作区中的文件**来修复它（用文件工具编辑，不要只给建议），并简要说明改了什么：\n\n${block}`

  await vscode.commands.executeCommand('dsh.openChat')
  await ctrl.sendExternal(prompt)
}
