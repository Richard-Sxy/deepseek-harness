/**
 * Counterfactual rule distiller: groups failure samples by
 * (tool, scenario, failureType, condition fingerprint) and produces
 * BLOCKING validation rules plus per-type repair hints.
 * Port of `app/services/counterfactual_distiller.py`.
 * @module @deepseek-ai/dsh-integration-skillforge/distiller
 */

import { FailureType, RuleSeverity } from './types.js'
import type { FailureRecord, RuleRecord } from './spec.js'

/** Repair steps per failure type (port of `_build_repair_path`). */
export const REPAIR_STEPS: Record<FailureType, string[]> = {
  [FailureType.PARAMETER_ERROR]: ['validate required fields', 'normalize parameter types', 'retry with safe defaults'],
  [FailureType.PERMISSION_DENIED]: ['check tenant policy', 'request delegated permission', 'fallback to read-only mode'],
  [FailureType.SCENE_MISMATCH]: ['match task scenario', 'select compatible tools', 're-plan downstream DAG'],
  [FailureType.DEPENDENCY_MISSING]: ['verify connector availability', 'install or enable dependency', 'retry after readiness check'],
  [FailureType.RUNTIME_EXCEPTION]: ['capture stack summary', 'retry with backoff', 'route to stable skill version'],
  [FailureType.RATE_LIMIT]: ['respect retry-after', 'back off with jitter', 'route to lower traffic'],
  [FailureType.SILENT_FAILURE]: ['verify world state', 'switch execution path', 're-plan affected subgoal'],
  [FailureType.PLAN_FAILURE]: ['inspect unmet constraints', 'rebuild affected subgoal', 'verify global plan'],
  [FailureType.BUDGET_EXCEEDED]: ['stop new actions', 'compact context', 'request a larger budget'],
  [FailureType.SAFETY_VIOLATION]: ['block the action', 'request confirmation', 'use a safer alternative'],
  [FailureType.UNKNOWN]: ['collect richer context', 'send to human review', 'avoid automatic retry loop'],
}

/** Trigger signals per failure type (port of `_trigger_signals`). */
export const TRIGGER_SIGNALS: Record<FailureType, string[]> = {
  [FailureType.PARAMETER_ERROR]: ['missing required field', 'invalid type', 'boundary violation'],
  [FailureType.PERMISSION_DENIED]: ['401/403 status', 'insufficient scope', 'tenant policy block'],
  [FailureType.SCENE_MISMATCH]: ['tools not in available set', 'unsupported scenario', 'planner mismatch'],
  [FailureType.DEPENDENCY_MISSING]: ['missing connector', 'module unavailable', 'disabled integration'],
  [FailureType.RUNTIME_EXCEPTION]: ['timeout', 'stack trace', 'retry exhaustion'],
  [FailureType.RATE_LIMIT]: ['429 status', 'retry-after', 'quota exhaustion'],
  [FailureType.SILENT_FAILURE]: ['state unchanged', 'postcondition failed'],
  [FailureType.PLAN_FAILURE]: ['deadlock', 'unmet global constraint'],
  [FailureType.BUDGET_EXCEEDED]: ['token budget', 'step budget', 'cost budget'],
  [FailureType.SAFETY_VIOLATION]: ['policy block', 'confirmation required'],
  [FailureType.UNKNOWN]: ['low confidence', 'unseen error text'],
}

export function repairSteps(failureType: string): string[] {
  return REPAIR_STEPS[failureType as FailureType] ?? REPAIR_STEPS[FailureType.UNKNOWN]
}

/** Condition fingerprint: sorted meaningful key/value pairs (port of `_condition_fingerprint`). */
function conditionFingerprint(condition: Record<string, unknown>): string {
  const meaningful = Object.entries(condition).filter(([, value]) =>
    value !== null && value !== undefined && value !== ''
    && !(Array.isArray(value) && value.length === 0)
    && !(typeof value === 'object' && value !== null && Object.keys(value).length === 0)
    && value !== false,
  )
  meaningful.sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(meaningful)
}

/** Build the condition object for a failure (port of `_build_condition`). */
function buildCondition(failure: FailureRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    tool_name: failure.toolName,
    scenario: failure.scenario,
    failure_type: failure.failureType,
  }
  const snippet = failure.errorMessage.slice(0, 80)
  switch (failure.failureType) {
    case FailureType.PARAMETER_ERROR:
      return { ...base, error_contains_any: ['missing', 'invalid', 'required', 'schema', '参数'] }
    case FailureType.PERMISSION_DENIED:
      return { ...base, error_contains_any: ['permission', 'forbidden', 'unauthorized', '401', '403', '权限'] }
    case FailureType.SCENE_MISMATCH:
      return { ...base, error_contains_any: ['scene', 'unsupported', 'mismatch', '场景'] }
    case FailureType.DEPENDENCY_MISSING:
      return { ...base, error_contains_any: ['dependency', 'module', 'not installed', '依赖'] }
    case FailureType.RUNTIME_EXCEPTION:
      return { ...base, error_contains_any: ['timeout', 'exception', 'traceback', '异常'] }
    case FailureType.RATE_LIMIT:
      return { ...base, error_contains_any: ['rate limit', '429', '限流'] }
    case FailureType.SILENT_FAILURE:
      return { ...base, error_contains_any: ['silent failure', 'state unchanged', 'postcondition'] }
    default:
      return { ...base, error_contains_any: [snippet] }
  }
}

/**
 * Distill grouped rules from failure records. Groups are keyed by
 * (tool, scenario, failureType, fingerprint); each group becomes one rule
 * whose confidence grows with its evidence count.
 */
/** 核心函数：输入失败规则记录，输出规则记录 */
export function distillRules(failures: FailureRecord[]): RuleRecord[] {
  // 构建失败记录：Map<string, {key{toolName, scenario, failureType}, failure}>
  const groups = new Map<string, { key: { toolName: string; scenario: string; failureType: string }; failures: FailureRecord[] }>()
  for (const failure of failures) {
    // 失败生成唯一指纹
    const fingerprint = conditionFingerprint(buildCondition(failure))
    const groupKey = [failure.toolName, failure.scenario, failure.failureType, fingerprint].join('::')
    let group = groups.get(groupKey)
    if (!group) {
      group = { key: { toolName: failure.toolName, scenario: failure.scenario, failureType: failure.failureType }, failures: [] }
      groups.set(groupKey, group)
    }
    group.failures.push(failure)
  }

  const rules: RuleRecord[] = []
  for (const group of groups.values()) {
    const first = group.failures[0]
    if (first === undefined) continue
    const condition = buildCondition(first)
    rules.push({
      name: `precheck_${first.toolName}_${first.failureType}`,
      toolName: first.toolName,
      scenario: first.scenario,
      failureType: first.failureType,
      severity: RuleSeverity.BLOCKING,
      condition,
      message: `Potential ${first.failureType} before calling ${first.toolName}.`,
      repairHint: repairSteps(first.failureType)[0] ?? '',
      confidence: Math.min(0.95, 0.55 + group.failures.length * 0.08),
      evidenceIds: group.failures.map(failure => failure.id),
      createdAt: Date.now(),
    })
  }
  return rules
}

/**
 * Text block the guard attaches when blocking a call: the rule message plus
 * its repair hint.
 */
export function ruleDenialReason(rule: RuleRecord): string {
  return `SkillForge rule "${rule.name}" blocked ${rule.toolName}: ${rule.message} Repair hint: ${rule.repairHint}`
}
