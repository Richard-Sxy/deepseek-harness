/**
 * Recovery policy: deterministic failure-type → recovery-action mapping.
 * Port of `app/services/recovery_policy.py`, simplified — DSH has no durable
 * PlanNode or budget at this seam, so the mapping drives model-facing repair
 * guidance instead of direct retry/scheduling.
 * @module @deepseek-ai/dsh-integration-skillforge/recovery
 */

import { FailureType, RepairAction } from './types.js'
import { repairSteps } from './distiller.js'

/**
 * Choose a recovery action for a failure type. The Python version consults
 * node alternatives and retry budgets; here those inputs are optional and
 * default to the conservative fallback.
 */
export function recoveryAction(
  failureType: FailureType,
  options: {
    hasAlternativeTool?: boolean
    hasRepairedParameters?: boolean
    retriesExhausted?: boolean
  } = {},
): RepairAction {
  if (options.retriesExhausted) return RepairAction.ABORT
  switch (failureType) {
    case FailureType.RUNTIME_EXCEPTION:
    case FailureType.RATE_LIMIT:
      return RepairAction.RETRY_SAME_ARGS
    case FailureType.PARAMETER_ERROR:
      // In DSH the model IS the repairer: pointing it at the arguments is
      // always actionable, while "ask the user" derailed real runs (the model
      // called ask_user_question mid-task and stalled).
      return RepairAction.RETRY_REPAIRED_ARGS
    case FailureType.PERMISSION_DENIED:
      // T4 finding: in DSH the model's own escape route is switching tools
      // (bash instead of a denied write/edit). Always suggest that; "ask the
      // user" is a dead end in headless and a derail in interactive runs.
      return RepairAction.SWITCH_TOOL
    case FailureType.DEPENDENCY_MISSING:
    case FailureType.SCENE_MISMATCH:
    case FailureType.SILENT_FAILURE:
      return options.hasAlternativeTool
        ? RepairAction.SWITCH_TOOL
        : RepairAction.REPLAN_SUBGOAL
    case FailureType.PLAN_FAILURE:
      return RepairAction.REPLAN_SUBGOAL
    default:
      return RepairAction.ABORT
  }
}

/** One-line guidance for the model after a failed call. */
/** 失败恢复指南，用 string 插入到 SystemPrompt 当中去 */
export function recoveryGuidance(
  failureType: FailureType,
  action: RepairAction,
  toolName: string,
  errorMessage = '',
): string {
  const lowerError = errorMessage.toLowerCase()
  // DSH filesystem-observation policy: the write was rejected because the
  // target was never read. Give the model the concrete fix instead of the
  // generic scene-mismatch ladder.
  if (lowerError.includes('fs_not_observed') || lowerError.includes('not been read')) {
    return (
      `SkillForge classified the ${toolName} failure as ${FailureType.SCENE_MISMATCH}. ` +
      'Recommended: read the target file first (DSH filesystem policy requires observing a file before writing it), then retry the write; '
      + 'or create the file via bash instead.'
    )
  }
  const steps = repairSteps(failureType)
  const actionText: Record<RepairAction, string> = {
    [RepairAction.RETRY_SAME_ARGS]: 'retry the same call',
    [RepairAction.RETRY_REPAIRED_ARGS]: 'repair the arguments before retrying',
    [RepairAction.SWITCH_TOOL]: 'switch to an alternative tool',
    [RepairAction.REPLAN_SUBGOAL]: 're-plan the affected subgoal',
    [RepairAction.ASK_USER]: 'ask the user for clarification',
    [RepairAction.ABORT]: 'stop and reconsider the approach',
  }
  return (
    `SkillForge classified the ${toolName} failure as ${failureType}. ` +
    `Recommended: ${actionText[action]}. Steps: ${steps.join('; ')}.`
  )
}
