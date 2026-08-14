/**
 * Model routing: plan/architecture → pro, grunt work → flash, failed turns →
 * proMax (with fallback). Manual override via RouteMode.
 */
import type { ModelIds, DshConfig } from './config.js'
import type { RouteMode } from './types.js'

/** Signals that a prompt is planning/architecture-flavored and deserves the pro model. */
const PRO_PATTERNS: RegExp[] = [
  // English
  /\b(architecture|architectural|design|plan|planning|proposal|roadmap|refactor|refactoring|design\s?doc|sdd|prd|spec|specification|trade-?off|tradeoffs|review|evaluate|compare|migration|strategy|survey|research|feasibility|blueprint|scalability|maintainability|technical\s?debt|system\s?design|high-?level|overview|choose|selection)\b/i,
  // 中文
  /架构|总体设计|详细设计|设计方案|技术方案|规划|评审|选型|调研|对比|权衡|重构|路线图|技术债|扩展性|可维护性|系统设计|演进|可行性|蓝图|技术栈|拆解|模块划分|接口设计|数据模型|ER\s?图|时序图|流程图/,
]

const DEBUG_ESCALATION_SIGNALS: RegExp[] = [
  /\b(debug|debugging|still failing|keeps failing|same error|again|retry|escalate|pro\s?max|还是不行|一直失败|反复失败|同样的错误|没解决|又报错|还是报错|debug\s?不|卡住|死循环)\b/i,
]

/** Classify a prompt into the base route. */
export function classifyPrompt(text: string): 'flash' | 'pro' {
  if (PRO_PATTERNS.some((re) => re.test(text))) return 'pro'
  return 'flash'
}

/** Whether the text itself asks for escalation to the strongest model. */
export function wantsEscalation(text: string): boolean {
  return DEBUG_ESCALATION_SIGNALS.some((re) => re.test(text))
}

/**
 * Resolve which model id to use for the next message.
 * @param mode - manual override ('auto' = route automatically).
 * @param prompt - the message text.
 * @param lastTurnFailed - whether the previous turn ended in error.
 * @param cfg - configuration (model ids, flags).
 */
export function resolveModelId(
  mode: RouteMode,
  prompt: string,
  lastTurnFailed: boolean,
  cfg: DshConfig,
): string {
  const models = cfg.models
  switch (mode) {
    case 'flash':
      return models.flash
    case 'pro':
      return models.pro
    case 'proMax':
      return models.proMax
    case 'auto':
    default:
      break
  }
  if (!cfg.autoRoute) return models.flash
  if (cfg.escalateOnFailure && lastTurnFailed) return models.proMax
  if (wantsEscalation(prompt)) return models.proMax
  return classifyPrompt(prompt) === 'pro' ? models.pro : models.flash
}

/** Human label for a RouteMode. */
export function routeModeLabel(mode: RouteMode): string {
  switch (mode) {
    case 'auto': return 'Auto'
    case 'flash': return 'Flash'
    case 'pro': return 'Pro'
    case 'proMax': return 'Pro Max'
  }
}
