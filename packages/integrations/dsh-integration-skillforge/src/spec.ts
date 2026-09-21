/**
 * The skillforge domain declaration: durable record schemas and the
 * `defineDomain` spec the service opens through `ctx.storageDomain`.
 * Records validate with zod at the durability boundary (same pattern as
 * `@deepseek-ai/dsh-workspace`).
 * @module @deepseek-ai/dsh-integration-skillforge/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** JSON-serializable parameter mapping (opaque to the domain layer). */
const jsonObject = z.record(z.string(), z.unknown())

/** One tool call inside a stored trajectory. */
export const turnCallRecord = z.object({
  toolName: z.string(),
  parameters: jsonObject,
  startedAt: z.number(),
  endedAt: z.number(),
  latencyMs: z.number(),
  success: z.boolean(),
  resultSummary: z.string().nullable(),
  errorMessage: z.string().nullable(),
})
export type TurnCallRecord = z.infer<typeof turnCallRecord>

/** One DSH turn stored as a trajectory (mining input). */
export const trajectoryRecord = z.object({
  sessionId: z.string(),
  turn: z.number(),
  scenario: z.string(),
  goal: z.string(),
  plannerTrace: z.array(z.string()),
  calls: z.array(turnCallRecord),
  createdAt: z.number(),
  /** Postcondition failures recorded for this turn; 0/absent = passed.
   *  Failed turns stay stored (audit) but never feed skill mining. */
  verificationFailures: z.number().optional(),
})
export type TrajectoryRecord = z.infer<typeof trajectoryRecord>

/** One classified failure sample (distiller input). */
export const failureRecord = z.object({
  id: z.string(),
  toolName: z.string(),
  scenario: z.string(),
  failureType: z.string(),
  parameters: jsonObject,
  errorMessage: z.string(),
  context: z.string(),
  createdAt: z.number(),
})
export type FailureRecord = z.infer<typeof failureRecord>

/** One distilled validation rule (guard input). */
export const ruleRecord = z.object({
  name: z.string(),
  toolName: z.string(),
  scenario: z.string(),
  failureType: z.string(),
  severity: z.string(),
  condition: jsonObject,
  message: z.string(),
  repairHint: z.string(),
  confidence: z.number(),
  evidenceIds: z.array(z.string()),
  createdAt: z.number(),
})
export type RuleRecord = z.infer<typeof ruleRecord>

/** One mined skill package. */
export const skillRecord = z.object({
  name: z.string(),
  scenario: z.string(),
  toolPath: z.array(z.string()),
  signature: z.string(),
  support: z.number(),
  confidence: z.number(),
  confidenceLower: z.number(),
  confidenceUpper: z.number(),
  avgLatencyMs: z.number(),
  avgTokenCost: z.number(),
  defaults: jsonObject,
  status: z.string(),
  skipPlanning: z.boolean(),
  riskLevel: z.string(),
  sourceTaskIds: z.array(z.string()),
  updatedAt: z.number(),
})
export type SkillRecord = z.infer<typeof skillRecord>

/** One failed postcondition verification (silent-failure record). */
export const verificationRecord = z.object({
  id: z.string(),
  sessionId: z.string(),
  turn: z.number(),
  kind: z.string(),
  target: z.string(),
  expected: z.string(),
  message: z.string(),
  createdAt: z.number(),
})
export type VerificationRecord = z.infer<typeof verificationRecord>

export const injectionRecord = z.object({
  /** Best-effort attribution from the most recent session event; absent
   *  when the prompt was assembled outside any observed session. */
  sessionId: z.string().optional(),
  skillNames: z.array(z.string()),
  createdAt: z.number(),
})
export type InjectionRecord = z.infer<typeof injectionRecord>

export const skillRevisionsRecord = z.object({
  id: z.string(),
  skillName: z.string(),
  revision: z.number(),
  /** The overwritten record; null marks first creation (rollback = delete). */
  record: skillRecord.nullable(),
  createdAt: z.number(),
})
export type SkillRevisionRecord = z.infer<typeof skillRevisionsRecord>

/**
 * The skillforge domain: four tables (trajectories, failures, rules,
 * skills), no global slot.
 */
export const skillforgeDomainSpec = defineDomain({
  name: 'skillforge',
  version: 1,
  tables: {
    trajectories: domainTable<string, TrajectoryRecord>(trajectoryRecord),
    failures: domainTable<string, FailureRecord>(failureRecord),
    rules: domainTable<string, RuleRecord>(ruleRecord),
    skills: domainTable<string, SkillRecord>(skillRecord),
    verifications: domainTable<string, VerificationRecord>(verificationRecord),
    injections: domainTable<string, InjectionRecord>(injectionRecord),
    skill_revisions: domainTable<string, SkillRevisionRecord>(skillRevisionsRecord),
  },
})
