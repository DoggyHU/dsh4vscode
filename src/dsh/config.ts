/**
 * Typed access to dsh.* VS Code settings.
 */
import * as vscode from 'vscode'

export interface DshConfig {
  baseUrl: string
  workspacePath: string
  agentPreset: string
  /** Auto-open the DSH chat editor window on VS Code startup (Claude Code parity). */
  autoOpenOnStartup: boolean
}

export function getDshConfig(): DshConfig {
  const cfg = vscode.workspace.getConfiguration('dsh')
  return {
    baseUrl: normalizeBaseUrl(cfg.get<string>('baseUrl', 'http://127.0.0.1:3080')),
    workspacePath: cfg.get<string>('workspacePath', ''),
    agentPreset: cfg.get<string>('agentPreset', 'standard'),
    autoOpenOnStartup: cfg.get<boolean>('autoOpenOnStartup', true),
  }
}

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  return url
}
