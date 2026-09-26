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
  minSupport: number        // 需要出现的次数
  minPathLength: number     // 最小路径长度 获取所有的最小路径长度
  maxPathLength: number     // 最大路径长度 获取所有的最大路径长度
  scenario?: string
}

/** Wilson score interval (port of `_wilson_interval`, z = 1.96). */
/** 观测成功率p，设置的置信区间95%：最终的真实存在区间可能存在的范围[lower, upper] */
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

/** 滑动窗口获取工具调用的内容 */
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

/** DAG 收集，主要标记：场景，路径，支持数量， */
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
/** 技能挖掘的核心函数 */
export function mineSkills(
  trajectories: TrajectoryRecord[],  // 轨迹记录
  options: MiningOptions,            // 技能挖掘选项
): SkillRecord[] {
  // 有机会晋升的 skill 内容
  const eligible = trajectories.filter(traj =>
    (options.scenario === undefined || traj.scenario === options.scenario)
    // G1 gate: turns whose postconditions failed are stored for audit but
    // never count as successful evidence (tool success ≠ task correctness).
    && (traj.verificationFailures ?? 0) === 0,    // 这边是 0 失败的记录
  )
  const totalEligible = Math.max(1, eligible.length)

  // DAG 生成的签名
  const bySignature = new Map<string, DagAccumulator>()
  for (const trajectory of eligible) {
    const successful = trajectory.calls.filter(call => call.success) // 过滤成功的轨迹
    if (successful.length < options.minPathLength) continue          // 如果成功路径小于最小路径长度
    for (const window of contiguousWindows(successful, options.minPathLength, options.maxPathLength)) {
      // 按照场景做分类
      const path = window.map(call => call.toolName)
      // 组装 场景：场景内容， name1 -> name2 -> name3 ...
      const signature = `${trajectory.scenario}::${path.join('->')}`
      // 获取工具是否存在，不存在的话就加入这一个对象
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
        // 加入这个对象
        bySignature.set(signature, acc)
      }
      // 存在的话这一个 acc 对象的出现次数 + 1
      // 添加 sessionId turn 这两个部分
      // 添加这一个窗口 window 是滑动窗口的内容
      // 添加这一个轨迹 trajectories 是整个链条
      acc.support += 1
      acc.sourceTasks.add(`${trajectory.sessionId}:turn${trajectory.turn}`)
      acc.windows.push(window)
      acc.trajectories.push(trajectory)
    }
  }

  // skill 生成 skill 候选
  const skills: SkillRecord[] = []
  // 对于高频调用做一个排序
  const sorted = [...bySignature.values()].sort((a, b) => b.support - a.support)
  for (const acc of sorted) {
    if (acc.support < options.minSupport) continue
    // 获取出现频次整个调用链的所有内容
    // 获取大致的置信区间
    // 风险等级(关键词匹配) 延迟(获取) 平均延迟(获取)
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

    // 记录
    const defaults: Record<string, unknown> = {}
    for (const [index, toolName] of acc.path.entries()) {
      // index 位置索引 toolName 工具名称
      // 对于每一条调用链做
      const nodeCalls = acc.windows
        .flatMap((window) => {const call = window[index]; return call == undefined ? [] : [call]})
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
      // 构建模版
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
