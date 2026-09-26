/**
 * Deterministic keyword fallback failure classifier.
 * Port of `app/services/failure_classifier.py::_rule_fallback` — the sklearn
 * TF-IDF pipeline is intentionally dropped; the keyword rules carry the
 * deterministic behavior and are identical in keyword set and priority order.
 * @module @deepseek-ai/dsh-integration-skillforge/classifier
 */

import { FailureType, type ClassificationResult, type FailureInput } from './types.js'

const PERMISSION_KEYWORDS = ['permission', 'forbidden', 'unauthorized', 'access denied', 'not permitted', '权限', '401', '403',
  // Sandbox / policy-wall vocabulary (T6R): these errors carry no signal in
  // the parameter chain, so without their own keywords they fell through to
  // the context fallback and were hijacked into parameter_error by planner
  // noise. The permission chain runs first, so they short-circuit here.
  'sandbox', 'escalation']
// No bare 'missing': it hijacks dependency errors ("missing_lib", "No module
// named 'missing_...'") into parameter_error. Compound forms only.
const PARAMETER_KEYWORDS = ['missing required', 'missing parameter', 'missing argument', 'missing field', 'invalid', 'required', 'schema', 'must differ', '参数', '字段', '类型', 'jsondecodeerror', 'syntaxerror', 'expecting property',
  // Empty-string value validation ("url must be a non-empty string"): the
  // key is present but the value is invalid — a parameter problem, not
  // unknown (T6R: previously landed in unknown).
  'non-empty']
const SCENE_KEYWORDS = ['scene', 'unsupported', 'mismatch', '场景', '不适用']
const DEPENDENCY_KEYWORDS = ['dependency', 'not installed', 'module', '依赖', 'no matching distribution', 'could not find a version', 'no module named', 'enoent']
const RATE_LIMIT_KEYWORDS = ['rate limit', '429', '限流']
const SILENT_FAILURE_KEYWORDS = ['silent failure', 'state unchanged', 'postcondition']
const PLAN_FAILURE_KEYWORDS = ['plan deadlock', 'plan failure', '计划失败']
const RUNTIME_KEYWORDS = ['exception', 'timeout', 'traceback', 'transient', '暂时', '异常', 'no such file', 'connection refused', 'failed to connect', 'command not found']
/** Harness filesystem-policy ordering errors (write before read etc.). */
const FS_POLICY_KEYWORDS = ['fs_not_observed', 'not been read', 'read the file first', 'fs error', 'filesystem observation']

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some(keyword => text.includes(keyword))
}

/** Match a text against the keyword chain, in the Python priority order. */
function matchFailureType(text: string): FailureType {
  if (containsAny(text, PERMISSION_KEYWORDS)) return FailureType.PERMISSION_DENIED
  if (containsAny(text, PARAMETER_KEYWORDS)) return FailureType.PARAMETER_ERROR
  if (containsAny(text, SCENE_KEYWORDS)) return FailureType.SCENE_MISMATCH
  if (containsAny(text, DEPENDENCY_KEYWORDS)) return FailureType.DEPENDENCY_MISSING
  if (containsAny(text, RATE_LIMIT_KEYWORDS)) return FailureType.RATE_LIMIT
  if (containsAny(text, SILENT_FAILURE_KEYWORDS)) return FailureType.SILENT_FAILURE
  if (containsAny(text, PLAN_FAILURE_KEYWORDS)) return FailureType.PLAN_FAILURE
  if (containsAny(text, RUNTIME_KEYWORDS)) return FailureType.RUNTIME_EXCEPTION
  // Last resort: a bare non-zero exit-code marker with no textual signal
  // (e.g. `curl -s` suppressing its own error output).
  if (/\[exit code: [1-9]/.test(text)) return FailureType.RUNTIME_EXCEPTION
  return FailureType.UNKNOWN
}

const SIGNAL_BY_TYPE: Record<FailureType, string> = {
  [FailureType.PERMISSION_DENIED]: 'permission_keywords',
  [FailureType.PARAMETER_ERROR]: 'parameter_keywords',
  [FailureType.SCENE_MISMATCH]: 'scene_keywords',
  [FailureType.DEPENDENCY_MISSING]: 'dependency_keywords',
  [FailureType.RATE_LIMIT]: 'rate_limit_keywords',
  [FailureType.SILENT_FAILURE]: 'silent_failure_keywords',
  [FailureType.PLAN_FAILURE]: 'plan_failure_keywords',
  [FailureType.RUNTIME_EXCEPTION]: 'runtime_keywords',
  [FailureType.BUDGET_EXCEEDED]: 'budget_keywords',
  [FailureType.SAFETY_VIOLATION]: 'safety_keywords',
  [FailureType.UNKNOWN]: 'unknown',
}

/**
 * Classify a failed tool call. Two-stage to stop the planner context from
 * hijacking the label: match the ERROR text first (tool name, scenario,
 * error message), and only fall back to the conversation context when the
 * error itself carries no signal. Harness FS-policy errors (write before
 * read) classify as scene_mismatch.
 */
export function classifyFailure(input: FailureInput): ClassificationResult {
  const errorText = [
    input.toolName,
    input.scenario,
    input.errorMessage,
  ].join(' ').toLowerCase()

  const signals: string[] = []
  const providedCount = Object.keys(input.parameters).length
  signals.push(`parameter_count:${providedCount}`)

  let failureType: FailureType = FailureType.UNKNOWN
  if (containsAny(errorText, FS_POLICY_KEYWORDS)) {
    failureType = FailureType.SCENE_MISMATCH
    signals.push('fs_policy_keywords')
  } else {
    failureType = matchFailureType(errorText)
    if (failureType !== FailureType.UNKNOWN) {
      signals.push(SIGNAL_BY_TYPE[failureType])
    } else {
      // Fallback: the error text alone carried no signal — retry with the
      // conversation context included.
      const fullText = `${errorText} ${input.context}`.toLowerCase()
      failureType = matchFailureType(fullText)
      if (failureType !== FailureType.UNKNOWN) signals.push(`${SIGNAL_BY_TYPE[failureType]}:context`)
    }
  }

  const confidence = failureType !== FailureType.UNKNOWN ? 0.55 : 0.2
  return { failureType, confidence, signals: signals.slice(0, 6) }
}

/**
 * Structural parameter check on the tool arguments: missing required keys.
 * The caller derives `required` from the parameter profiler (keys present in
 * every successful call of the tool). An empty-string value counts as
 * missing: successful calls never carried it (T3 — `url: ""` slipped past
 * the absence check and died in the tool's own validation instead).
 */
export function missingRequiredParameters(
  parameters: Record<string, unknown>,
  required: readonly string[],
): string[] {
  return required.filter(key => !(key in parameters) || parameters[key] === '')
}
