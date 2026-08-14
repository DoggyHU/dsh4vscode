/**
 * Typed access to dsh.* VS Code settings.
 */
import * as vscode from 'vscode'
import type { RouteMode } from './types.js'

export interface ModelIds {
  flash: string
  pro: string
  proMax: string
}

export interface ReasoningEfforts {
  flash: string
  pro: string
  proMax: string
}

export interface DshConfig {
  baseUrl: string
  provider: string
  models: ModelIds
  reasoningEffort: string
  reasoningEfforts: ReasoningEfforts
  autoRoute: boolean
  escalateOnFailure: boolean
  workspacePath: string
  agentPreset: string
}

const DEFAULT_MODELS: ModelIds = {
  flash: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro',
  proMax: 'deepseek-v4-pro-max',
}

const DEFAULT_EFFORTS: ReasoningEfforts = {
  flash: 'high',
  pro: 'max',
  proMax: 'max',
}

export function getDshConfig(): DshConfig {
  const cfg = vscode.workspace.getConfiguration('dsh')
  const rawModels = cfg.get<Partial<ModelIds>>('models', {})
  const rawEfforts = cfg.get<Partial<ReasoningEfforts>>('reasoningEfforts', {})
  return {
    baseUrl: normalizeBaseUrl(cfg.get<string>('baseUrl', 'http://127.0.0.1:3080')),
    provider: cfg.get<string>('provider', 'deepseek-official'),
    models: {
      flash: rawModels.flash || DEFAULT_MODELS.flash,
      pro: rawModels.pro || DEFAULT_MODELS.pro,
      proMax: rawModels.proMax || DEFAULT_MODELS.proMax,
    },
    reasoningEffort: cfg.get<string>('reasoningEffort', 'high'),
    reasoningEfforts: {
      flash: rawEfforts.flash || DEFAULT_EFFORTS.flash,
      pro: rawEfforts.pro || DEFAULT_EFFORTS.pro,
      proMax: rawEfforts.proMax || DEFAULT_EFFORTS.proMax,
    },
    autoRoute: cfg.get<boolean>('autoRoute', true),
    escalateOnFailure: cfg.get<boolean>('escalateOnFailure', true),
    workspacePath: cfg.get<string>('workspacePath', ''),
    agentPreset: cfg.get<string>('agentPreset', 'standard'),
  }
}

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  return url
}

/** Persisted route-mode key (per machine via globalState). */
export const ROUTE_MODE_KEY = 'dsh.routeMode'
export const SESSION_ID_KEY = 'dsh.sessionId.v1'

export function defaultRouteMode(): RouteMode {
  return 'auto'
}
