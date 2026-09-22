/**
 * Parameter profiler: learns per-tool parameter defaults, bounds, allowed
 * values, and required keys from successful tool calls.
 * Port of `app/services/parameter_profiler.py`; the numeric default is the
 * Gaussian-KDE mode over a 100-point grid (bandwidth = range/10, densest
 * point wins) with the median as the small-sample fallback — a dependency-
 * free port of the original sklearn `KernelDensity` path.
 * @module @deepseek-ai/dsh-integration-skillforge/profiler
 */

import type { TurnCall } from './types.js'

/** parameter constraint */
export interface ParameterConstraint {
  parameterName: string
  valueType: 'number' | 'boolean' | 'category' | 'array' | 'object' | 'mixed'
  required: boolean
  default: unknown
  confidence: number
  minValue?: number
  maxValue?: number
  hardMin?: number
  hardMax?: number
  allowedValues?: unknown[]
  sampleCount: number
  /** How the numeric default was derived (audit parity with the Python original). */
  evidence?: { method: 'kde' | 'median' }
}

/** Tool parameters template. */
export interface ToolParameterTemplate {
  toolName: string
  scenario: string
  constraints: Record<string, ParameterConstraint>
  defaults: Record<string, unknown>
  requiredKeys: string[]
  sampleCount: number
}

/** Linear-interpolated quantile over an ascending array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const lower = sorted[base]!
  const upper = sorted[base + 1] ?? lower
  return lower + rest * (upper - lower)
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && !Number.isNaN(value)
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

/** Restore ints when every example was an int (port of `_restore_int_if_possible`). */
function restoreInt(value: number, examples: number[]): number {
  return examples.every(Number.isInteger) ? Math.round(value) : value
}

/**
 * Gaussian-KDE mode over a 100-point grid between the hard bounds: the
 * densest cluster centre of the observed values (bandwidth = range/10).
 * Normalisation is omitted — argmax is invariant to it. Deterministic and
 * dependency-free; a degenerate (single-value) range returns that value.
 */
function kdeMode(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const lower = sorted[0]!
  const upper = sorted[sorted.length - 1]!
  const bandwidth = Math.max((upper - lower) / 10, 1e-3)
  let best = quantile(sorted, 0.5)
  let bestDensity = -Infinity
  for (let index = 0; index < 100; index += 1) {
    const point = lower + (upper - lower) * (index / 99)
    let density = 0
    for (const sample of values) {
      const z = (point - sample) / bandwidth
      density += Math.exp(-0.5 * z * z)
    }
    if (density > bestDensity) {
      bestDensity = density
      best = point
    }
  }
  return best
}

/** 数值约束 */
function numericConstraint(
  key: string,
  values: number[],
  required: boolean,
  quantileClip: number,
): ParameterConstraint {
  const sorted = [...values].sort((a, b) => a - b)
  const hardLower = sorted[0]!
  const hardUpper = sorted[sorted.length - 1]!
  // KDE mode from 3+ samples (port parity with the Python sklearn path);
  // median below that. On multi-modal histories the mode stays inside a
  // validated cluster where the median can land on a never-used value.
  const useKde = values.length >= 3
  const default_ = useKde ? kdeMode(values) : quantile(sorted, 0.5)
  const lower = quantile(sorted, quantileClip)
  const upper = quantile(sorted, 1 - quantileClip)
  const spread = hardUpper - hardLower
  let confidence = Math.min(0.95, 0.45 + values.length / 50)
  if (spread === 0) confidence = Math.min(0.98, confidence + 0.15)
  return {
    parameterName: key,
    valueType: 'number',
    required,
    default: restoreInt(default_, values),
    confidence,
    minValue: restoreInt(lower, values),
    maxValue: restoreInt(upper, values),
    hardMin: restoreInt(hardLower, values),
    hardMax: restoreInt(hardUpper, values),
    sampleCount: values.length,
    evidence: { method: useKde ? 'kde' : 'median' },
  }
}

/** 类型约束 */
function categoricalConstraint(
  key: string,
  values: unknown[],
  required: boolean,
  valueType: 'boolean' | 'category',
): ParameterConstraint {
  const counts = new Map<string, { count: number; example: unknown }>()
  for (const value of values) {
    const text = String(value)
    const entry = counts.get(text)
    if (entry) entry.count += 1
    else counts.set(text, { count: 1, example: value })
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0]!
  const allowedValues = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry.example)
  const confidence = Math.min(0.95, top[1].count / values.length + values.length / 100)
  const rejectedValues = [...counts.entries()]
    .filter(([, entry]) => entry.count === 1 && values.length >= 10)
    .map(([, entry]) => entry.example)
  return {
    parameterName: key,
    valueType,
    required,
    default: top[1].example,
    confidence,
    allowedValues,
    sampleCount: values.length,
    ...rejectedValues.length > 0 ? { rejectedValues } : {},
  } as ParameterConstraint
}

function shapeConstraint(
  key: string,
  values: unknown[],
  required: boolean,
  valueType: 'array' | 'object',
): ParameterConstraint {
  return {
    parameterName: key,
    valueType,
    required,
    default: values[0] ?? null,
    confidence: Math.min(0.8, 0.35 + values.length / 80),
    sampleCount: values.length,
  }
}

function buildConstraint(
  key: string,
  values: unknown[],
  required: boolean,
  quantileClip: number,
): ParameterConstraint {
  const numericValues = values.filter(isNumber)
  const booleanValues = values.filter(isBoolean)
  if (numericValues.length > 0 && numericValues.length >= values.length * 0.8) {
    return numericConstraint(key, numericValues, required, quantileClip)
  }
  if (booleanValues.length > 0 && booleanValues.length >= values.length * 0.8) {
    return categoricalConstraint(key, booleanValues, required, 'boolean')
  }
  if (values.every(value => Array.isArray(value))) {
    return shapeConstraint(key, values, required, 'array')
  }
  if (values.every(value => typeof value === 'object' && value !== null && !Array.isArray(value))) {
    return shapeConstraint(key, values, required, 'object')
  }
  if (values.every(value => ['string', 'number', 'boolean'].includes(typeof value))) {
    return categoricalConstraint(key, values, required, 'category')
  }
  return {
    parameterName: key,
    valueType: 'mixed',
    required,
    default: values[0] ?? null,
    confidence: 0.2,
    sampleCount: values.length,
  }
}

/**
 * Build a parameter template from successful calls of one tool.
 * `requiredKeys` are the keys present in every successful call (>= 1 sample)
 * — the DSH-native substitute for Python's parameter snapshots.
 */
export function buildTemplate(
  calls: TurnCall[],
  toolName: string,
  scenario: string,
  quantileClip = 0.05,
): ToolParameterTemplate {
  const successful = calls.filter(call => call.success)
  const valuesByKey = new Map<string, unknown[]>()
  const presenceByKey = new Map<string, number>()
  for (const call of successful) {
    for (const [key, value] of Object.entries(call.parameters)) {
      const values = valuesByKey.get(key)
      if (values) values.push(value)
      else valuesByKey.set(key, [value])
      presenceByKey.set(key, (presenceByKey.get(key) ?? 0) + 1)
    }
  }

  const constraints: Record<string, ParameterConstraint> = {}
  const defaults: Record<string, unknown> = {}
  const requiredKeys: string[] = []
  for (const [key, values] of valuesByKey) {
    const required = (presenceByKey.get(key) ?? 0) === successful.length
    const constraint = buildConstraint(key, values, required, quantileClip)
    constraints[key] = constraint
    defaults[key] = constraint.default
    if (constraint.required) requiredKeys.push(key)
  }

  return {
    toolName: toolName || (successful[0]?.toolName ?? 'unknown'),
    scenario,
    constraints,
    defaults,
    requiredKeys,
    sampleCount: successful.length,
  }
}

/** Tool + scenario grouping key. */
export function templateKey(toolName: string, scenario: string): string {
  return `${scenario}::${toolName}`
}
