/**
 * Skill credit scoring: weighted success / latency / token / volume score
 * with idle decay, mapped to lifecycle status and actions.
 * Port of `app/services/skill_scoring.py::score`.
 * @module @deepseek-ai/dsh-integration-skillforge/scoring
 */

import { SkillStatus } from './types.js'
import type { SkillRecord } from './spec.js'

/** Credit Policy 表示不同部分打分的权重 */
export interface CreditPolicy {
  successWeight: number
  latencyWeight: number
  tokenWeight: number
  volumeWeight: number
  lowSuccessRate: number
  highTokenRatio: number
  highLatencyRatio: number
  minInvocationsForActive: number
  degradedThreshold: number
  canaryThreshold: number
  activeThreshold: number
  latencyBudgetMs: number
  tokenBudget: number
  minIdleDecay: number
  dailyIdleDecay: number
  recoveryQualityWeight: number
  constraintPenaltyWeight: number
}

export const DEFAULT_POLICY: CreditPolicy = {
  successWeight: 0.5,
  latencyWeight: 0.2,
  tokenWeight: 0.2,
  volumeWeight: 0.1,
  lowSuccessRate: 0.6,
  highTokenRatio: 0.8,
  highLatencyRatio: 0.8,
  minInvocationsForActive: 5,
  degradedThreshold: 30,
  canaryThreshold: 50,
  activeThreshold: 70,
  latencyBudgetMs: 30000,
  tokenBudget: 5000,
  minIdleDecay: 0.5,
  dailyIdleDecay: 0.01,
  recoveryQualityWeight: 0.1,
  constraintPenaltyWeight: 0.15,
}

export interface ScoreResult {
  score: number
  status: SkillStatus
  reasons: string[]
}

/** 构建一个 Skill 状态：已下线，降级，候选，灰度测试，激活 */
const STATUS_ORDER: Record<SkillStatus, number> = {
  [SkillStatus.OFFLINE]: 0,
  [SkillStatus.DEGRADED]: 1,
  [SkillStatus.CANDIDATE]: 2,
  [SkillStatus.CANARY]: 3,
  [SkillStatus.ACTIVE]: 4,
}

function statusFromScore(
  score: number,
  metrics: {
    successRate: number
    invocationCount: number
  },
  policy: CreditPolicy,
): SkillStatus {
  let status: SkillStatus
  if (score < policy.degradedThreshold) status = SkillStatus.OFFLINE
  else if (score < policy.canaryThreshold) status = SkillStatus.DEGRADED
  else if (score < policy.activeThreshold || metrics.invocationCount < policy.minInvocationsForActive) status = SkillStatus.CANARY
  else status = SkillStatus.ACTIVE
  if (metrics.successRate < policy.lowSuccessRate && metrics.invocationCount >= policy.minInvocationsForActive) {
    status = metrics.successRate < 0.35 ? SkillStatus.OFFLINE : SkillStatus.DEGRADED
  }
  return status
}

function idleDecay(lastUsedAt: number | undefined, now: number, policy: CreditPolicy): number {
  if (lastUsedAt === undefined) return Math.max(policy.minIdleDecay, 0.7)
  const idleDays = Math.max(0, Math.floor((now - lastUsedAt) / 86400000))
  return Math.max(policy.minIdleDecay, 1 - idleDays * policy.dailyIdleDecay)
}

/**
 * Score a skill from its mining evidence. Success rate is the skill's
 * confidence; invocation volume is its support count; latency is the mean
 * window latency. No separate recovery-rate signal exists yet (would come
 * from tracking reuse outcomes), so the quality factor stays neutral.
 */
export function scoreSkill(
  skill: SkillRecord,
  now = Date.now(),
  policy: CreditPolicy = DEFAULT_POLICY,
): ScoreResult {
  const total = policy.successWeight + policy.latencyWeight + policy.tokenWeight + policy.volumeWeight
  const weights = total === 0
    ? { success: 0.5, latency: 0.2, token: 0.2, volume: 0.1 }
    : {
      success: policy.successWeight / total,
      latency: policy.latencyWeight / total,
      token: policy.tokenWeight / total,
      volume: policy.volumeWeight / total,
    }

  const successRate = skill.confidence
  const latencyRatio = skill.avgLatencyMs / policy.latencyBudgetMs
  const tokenRatio = skill.avgTokenCost / policy.tokenBudget
  const latencyScore = Math.max(0, 1 - latencyRatio)
  const tokenScore = Math.max(0, 1 - tokenRatio)
  const volumeScore = Math.min(1, skill.support / Math.max(policy.minInvocationsForActive, 1))
  const decay = idleDecay(skill.updatedAt, now, policy)

  let rawScore = (
    weights.success * successRate
    + weights.latency * latencyScore
    + weights.token * tokenScore
    + weights.volume * volumeScore
  )
  rawScore = Math.max(0, rawScore)
  const score = 100 * rawScore * decay

  const reasons: string[] = []
  if (skill.confidence < policy.lowSuccessRate) reasons.push('low_success_rate')
  if (tokenRatio >= policy.highTokenRatio) reasons.push('high_token_cost')
  if (latencyRatio >= policy.highLatencyRatio) reasons.push('high_latency')
  if (skill.support < policy.minInvocationsForActive) reasons.push('insufficient_volume')
  if (decay < 0.8) reasons.push('idle_decay')
  if (skill.confidenceLower < policy.lowSuccessRate) reasons.push('low_success_confidence_bound')

  const status = statusFromScore(score, { successRate, invocationCount: skill.support }, policy)
  return { score: Math.round(score * 100) / 100, status, reasons }
}

/** Whether a skill may skip planning / be surfaced to the model. */
export function isUsable(status: SkillStatus): boolean {
  return status === SkillStatus.ACTIVE || status === SkillStatus.CANARY
}

export function promoteAction(previous: SkillStatus, current: SkillStatus): string {
  if (STATUS_ORDER[current] > STATUS_ORDER[previous]) return 'promote'
  if (STATUS_ORDER[current] < STATUS_ORDER[previous]) {
    return current !== SkillStatus.OFFLINE ? 'degrade' : 'offline'
  }
  return 'keep'
}

export function statusOrder(status: SkillStatus): number {
  return STATUS_ORDER[status]
}
