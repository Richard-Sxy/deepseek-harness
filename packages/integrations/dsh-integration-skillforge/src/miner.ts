/**
 * Skill miner: extracts frequent consecutive tool-call DAGs from successful
 * trajectories via sliding windows and packages them as skills with Wilson
 * confidence intervals. Port of `app/services/skill_miner.py`.
 * @module @deepseek-ai/dsh-integration-skillforge/miner
 */

import { SkillStatus } from './types.js'
import type { SkillRecord, TrajectoryRecord, TurnCallRecord } from './spec.js'
import { buildTemplate } from './profiler.js'

/** minPathLength/maxPathLength 存储的内容，minSupport 表示最低频率要求的内容 */
export interface MiningOptions {
  minSupport: number
  minPathLength: number
  maxPathLength: number
  scenario?: string
}

/** Wilson score interval (port of `_wilson_interval`, z = 1.96). */
function wilsonInterval(successes: number, total: number): [number, number] {
  if (total <= 0) return [0, 1]
  const z = 1.96
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)
  const lower = Math.max(0, (centre - margin) / denominator)
  const upper = Math.min(1, (centre + margin) / denominator)
  return [Math.round(lower * 1e6) / 1e6, Math.round(upper * 1e6) / 1e6]
}

/** Contiguous sliding windows (port of `_contiguous_windows`). */
function contiguousWindows(
  calls: TurnCallRecord[],
  minPathLength: number,
  maxPathLength: number,
): TurnCallRecord[][] {
  const windows: TurnCallRecord[][] = []
  const upper = Math.min(maxPathLength, calls.length)
  for (let size = minPathLength; size <= upper; size += 1) {
    for (let start = 0; start + size <= calls.length; start += 1) {
      windows.push(calls.slice(start, start + size))
    }
  }
  return windows
}

const RISK_WORDS = ['update', 'delete', 'send', 'transfer', 'write', 'edit']

/** DAG accumulator */
interface DagAccumulator {
  scenario: string
  path: string[]
  support: number
  sourceTasks: Set<string>
  windows: TurnCallRecord[][]
  trajectories: TrajectoryRecord[]
}

/**
 * Mine skills from stored trajectories. Only successful call chains
 * participate; a path is frequent when its support reaches `minSupport`.
 */
/** 核心函数 */
export function mineSkills(
  trajectories: TrajectoryRecord[],
  options: MiningOptions,
): SkillRecord[] {
  // 有机会晋升的 skill 内容
  const eligible = trajectories.filter(traj =>
    (options.scenario === undefined || traj.scenario === options.scenario)
    // G1 gate: turns whose postconditions failed are stored for audit but
    // never count as successful evidence (tool success ≠ task correctness).
    && (traj.verificationFailures ?? 0) === 0,
  )
  const totalEligible = Math.max(1, eligible.length)

  // DAG 生成的签名
  const bySignature = new Map<string, DagAccumulator>()
  for (const trajectory of eligible) {
    const successful = trajectory.calls.filter(call => call.success)
    if (successful.length < options.minPathLength) continue
    for (const window of contiguousWindows(successful, options.minPathLength, options.maxPathLength)) {
      const path = window.map(call => call.toolName)
      const signature = `${trajectory.scenario}::${path.join('->')}`
      let acc = bySignature.get(signature)
      if (!acc) {
        acc = {
          scenario: trajectory.scenario,
          path,
          support: 0,
          sourceTasks: new Set(),
          windows: [],
          trajectories: [],
        }
        bySignature.set(signature, acc)
      }
      acc.support += 1
      acc.sourceTasks.add(`${trajectory.sessionId}:turn${trajectory.turn}`)
      acc.windows.push(window)
      acc.trajectories.push(trajectory)
    }
  }

  // skill 生成 skill 候选
  const skills: SkillRecord[] = []
  const sorted = [...bySignature.values()].sort((a, b) => b.support - a.support)
  for (const acc of sorted) {
    if (acc.support < options.minSupport) continue
    const confidence = Math.min(0.98, acc.support / totalEligible)
    const [lower, upper] = wilsonInterval(acc.support, Math.max(acc.support, acc.windows.length))
    const riskLevel = acc.path.some(name =>
      RISK_WORDS.some(word => name.toLowerCase().includes(word)),
    ) ? 'high' : 'low'
    const latencyValues = acc.windows.map(window =>
      window.reduce((sum, call) => sum + call.latencyMs, 0),
    )
    const avgLatencyMs = latencyValues.length > 0
      ? latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length
      : 0
    // DSH sessions carry no per-call token accounting; the field stays 0.
    const avgTokenCost = 0

    // 记录 nodeCalls 
    const defaults: Record<string, unknown> = {}
    for (const [index, toolName] of acc.path.entries()) {
      const nodeCalls = acc.windows
        .flatMap(window => (window.length > index ? [window[index]!] : []))
        .map(call => ({
          callId: '',
          toolName: call.toolName,
          parameters: call.parameters,
          startedAt: call.startedAt,
          endedAt: call.endedAt,
          latencyMs: call.latencyMs,
          success: call.success,
          resultSummary: call.resultSummary,
          errorMessage: call.errorMessage,
        }))
      const template = buildTemplate(nodeCalls, toolName, acc.scenario)
      defaults[toolName] = template.defaults
    }

    const skipPlanning = confidence >= 0.5 && acc.support >= 2 && riskLevel !== 'high'
    const status: SkillStatus = confidence >= 0.8 && acc.support >= 5
      ? SkillStatus.ACTIVE
      : SkillStatus.CANARY

    skills.push({
      name: `${acc.scenario}_${acc.path.join('_then_')}`,
      scenario: acc.scenario,
      toolPath: acc.path,
      signature: `${acc.scenario}::${acc.path.join('->')}`,
      support: acc.support,
      confidence,
      confidenceLower: lower,
      confidenceUpper: upper,
      avgLatencyMs,
      avgTokenCost,
      defaults,
      status,
      skipPlanning,
      riskLevel,
      sourceTaskIds: [...acc.sourceTasks].sort(),
      updatedAt: Date.now(),
    })
  }
  return skills
}
