/**
 * Wire types for the DSH web API (packages/host/apiproxy + client/connection).
 * Shapes are hand-picked from the DSH source so the extension compiles with
 * zero dependency on the DSH checkout.
 */

/** RPC envelope sent to POST /api/<method>. */
export interface ClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

/** RPC envelope returned by POST /api/<method>. */
export interface ServerResponse {
  type: 'server-response'
  rpcId: string
  result: RpcResult<unknown>
}

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError }

export interface RpcError {
  code: string
  message: string
  details: Record<string, unknown>
}

/** Server → client push frame over /api/events.mux and /api/events.host. */
export interface ServerRequest {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

// ---- session domain ----

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
}

export interface CreateSessionPayload {
  workspaceId?: string
  cwd?: string
  sessionId?: string
  agentPreset?: string
}

export interface CreateSessionValue {
  sessionId: string
  agentPreset?: string
}

/** One workspace registry row (workspace.create / workspace.list). */
export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt?: string
  updatedAt?: string
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: string
  sourceEventSeqs?: number[]
  ignorable?: true
}

export interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

export interface HistoryValue {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoning {
  efforts: { id: string; name: string; description?: string }[]
  defaultEffort?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoning
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface ModelsValue {
  current: ModelSelection
  routable: boolean
  groups: ModelProviderGroup[]
  failures: unknown[]
}

// ---- agent preset catalog ----

/** One discoverable agent preset (an `agentPreset.list` row). */
export interface AgentPresetInfo {
  id: string
  trust: 'system' | 'user'
  /** Whether this preset is the deployment default. */
  isDefault: boolean
  /** Human-facing display name; falls back to the id when absent. */
  name?: string
  /** One sentence on what this preset is for. */
  description?: string
  broken?: { message: string }
}

export interface AgentPresetListValue {
  presets: AgentPresetInfo[]
  authorable: boolean
  hasDocument: boolean
}

export interface PromptPayload {
  sessionId: string
  mode: 'queue' | 'steer'
  content: { type: 'text'; text: string }[]
  clientTimeZone?: string
}

/** One pending inbox occurrence in the authoritative `session/queue` snapshot. */
export interface QueuedInboxItem {
  /** Message identity used by inbox mutations. */
  id: string
  /** Agent-resolved FIFO placement; queued and steering render on different surfaces. */
  placement: 'queued' | 'steering' | 'context'
  /** Complete pending message; not durable until the Agent claims it. */
  message: { content: ContentBlock[]; source?: { kind?: string; [k: string]: unknown } }
}

export interface PromptValue {
  accepted: true
  command?: { kind: string; text?: string }
}

// ---- event data shapes (session.event data) ----

export interface TextBlock { type: 'text'; text: string }
export interface ReasoningBlock { type: 'reasoning'; text: string }
export interface ToolCallBlock { type: 'tool-call'; id: string; name: string; arguments: string }
export interface ImageBlock { type: 'image'; attachment: unknown }
export interface ToolResultBlock { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }
export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ImageBlock | ToolResultBlock

/** user/message event data: the UserMessage itself (no wrapper, no turn). */
export interface UserMessageData {
  content: ContentBlock[]
  source?: { kind?: string; [k: string]: unknown }
  role?: string
  id?: string
}
export interface AssistantMessageData { turn: number; step: number; message: { role: string; content: ContentBlock[] }; usage?: unknown }

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: { kind: string } }

export interface AssistantChunkData { turn: number; step: number; chunk: StreamChunk }

export interface ToolCallData { turn: number; step: number; callId: string; name: string; arguments: string }
export interface ToolResultData {
  turn: number
  step: number
  message: {
    role: string
    content: ContentBlock[]
    source?: { kind?: string; callId?: string }
  }
  error?: { name: string; code: string }
  meta?: unknown
}

export interface TurnEndData { turn: number; reason: { kind: string } & Record<string, unknown> }

/** Mux frame union (payload slot of a mux-stream ServerRequest). */
export type MuxFrame =
  | { type: 'session/event'; sessionId: string; event: SessionEvent; view?: unknown }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: string }
  | { type: 'question/requested'; sessionId: string; questions: { id: string; question: string; detail?: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] }
  | { type: 'question/resolved'; sessionId: string; questionRpcId: string; outcome: 'answered' | 'cancelled' }
  | { type: 'session/queue'; sessionId: string; items: QueuedInboxItem[] }
  | { type: 'session/jobs'; sessionId: string; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: RpcError }

/** Host frame union (payload slot of a host-stream ServerRequest). */
export type HostFrame =
  | { type: 'host/session-added'; sessionId: string; blank: boolean; parentSessionId?: string; origin?: string; cwd?: string; agentPreset?: string }
  | { type: 'host/session-removed'; sessionId: string }
  | { type: 'host/session-status'; sessionId: string; running: boolean }
  | { type: 'host/agent-error'; sessionId: string; message: string }
  | { type: 'host/workspace-changed'; workspace: unknown }
  | { type: 'host/workspace-removed'; workspaceId: string }
  | { type: 'host/workspace-order-changed'; workspaceIds: string[] }
  | { type: 'host/archived-sessions-changed'; archivedSessionIds: string[] }
  | { type: 'host/remote-event'; event: string; args: unknown[] }
  | { type: 'stream/error'; error: RpcError }

// ---- chat model (extension-side) ----

export type ChatItem =
  | { kind: 'text'; id: string; role: 'user' | 'assistant'; text: string; reasoning?: string }
  | { kind: 'tool'; id: string; callId: string; name: string; args: string; state: 'running' | 'done' | 'error'; resultText?: string; isError?: boolean }

export interface ChatTurn {
  id: number
  items: ChatItem[]
  status: 'running' | 'done' | 'error' | 'aborted' | 'max-tokens' | 'blocked' | 'interrupted'
  model: string
  errorMessage?: string
}

/** One session tab's metadata. */
export interface ChatSessionMeta {
  sessionId: string
  title: string
  running: boolean
  /** Whether this session exists in the DSH instance (vs a fresh local one). */
  persisted: boolean
}

export interface ChatSnapshot {
  activeSessionId: string
  cwd: string
  sessions: ChatSessionMeta[]
  turns: ChatTurn[]
  /** Pending queue (queued/steering messages shown in the queue dock). */
  queue: QueuedInboxItem[]
  connected: boolean
  baseUrl: string
  running: boolean
  /** Provider-grouped catalog — the same source the DSH Web UI renders. */
  catalogGroups: CatalogGroup[]
  /** The session's current model selection as reported by DSH (session.models). */
  modelCurrent?: ModelSelection
  /** Current permission preset (read-only / workspace-write / danger-full-access). */
  permission: string
  permissionOptions: string[]
}

/** One model in the grouped catalog (lean webview-safe shape). */
export interface CatalogModelEntry {
  id: string
  name: string
  efforts: string[]
  defaultEffort?: string
}

/** One provider group of the catalog. */
export interface CatalogGroup {
  id: string
  name: string
  models: CatalogModelEntry[]
}
