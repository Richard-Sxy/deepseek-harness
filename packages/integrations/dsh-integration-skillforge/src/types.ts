/**
 * Shared vocabulary for the SkillForge-in-DSH learning pipeline.
 * Ported from SkillForge Python enums (`app/core/enums.py`).
 * @module @deepseek-ai/dsh-integration-skillforge/types
 */

/** Failure classification labels (values identical to the Python StrEnum). */
export const FailureType = {
  PARAMETER_ERROR: 'parameter_error',
  PERMISSION_DENIED: 'permission_denied',
  SCENE_MISMATCH: 'scene_mismatch',
  DEPENDENCY_MISSING: 'dependency_missing',
  RUNTIME_EXCEPTION: 'runtime_exception',
  RATE_LIMIT: 'rate_limit',
  SILENT_FAILURE: 'silent_failure',
  PLAN_FAILURE: 'plan_failure',
  BUDGET_EXCEEDED: 'budget_exceeded',
  SAFETY_VIOLATION: 'safety_violation',
  UNKNOWN: 'unknown',
} as const
export type FailureType = typeof FailureType[keyof typeof FailureType]

/** Skill lifecycle status. */
export const SkillStatus = {
  CANDIDATE: 'candidate',
  CANARY: 'canary',
  ACTIVE: 'active',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
} as const
export type SkillStatus = typeof SkillStatus[keyof typeof SkillStatus]

/** Rule severity. Only BLOCKING rules gate tool dispatch. */
export const RuleSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  BLOCKING: 'blocking',
} as const
export type RuleSeverity = typeof RuleSeverity[keyof typeof RuleSeverity]

/** Recovery actions a failure type maps to (port of `RecoveryAction`). */
export const RepairAction = {
  RETRY_SAME_ARGS: 'retry_same_args',
  RETRY_REPAIRED_ARGS: 'retry_repaired_args',
  SWITCH_TOOL: 'switch_tool',
  REPLAN_SUBGOAL: 'replan_subgoal',
  ASK_USER: 'ask_user',
  ABORT: 'abort',
} as const
export type RepairAction = typeof RepairAction[keyof typeof RepairAction]

/** One tool execution reconstructed from tool/call + tool/result events. */
export interface TurnCall {
  callId: string
  toolName: string
  parameters: Record<string, unknown>
  startedAt: number
  endedAt: number
  latencyMs: number
  success: boolean
  resultSummary: string | null
  errorMessage: string | null
}

/** One DSH turn, ready for persistence / mining. */
export interface TurnRecord {
  sessionId: string
  turn: number
  goal: string
  plannerTrace: string[]
  calls: TurnCall[]
}

/** Classification input: what the classifier sees after a failed call. */
export interface FailureInput {
  toolName: string
  scenario: string
  parameters: Record<string, unknown>
  errorMessage: string
  context: string
}

/** Classification output. */
export interface ClassificationResult {
  failureType: FailureType
  confidence: number
  signals: string[]
}
