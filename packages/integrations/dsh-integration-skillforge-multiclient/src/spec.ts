/**
 * Durable records for multi-client SkillForge evidence coordination.
 * @module @deepseek-ai/dsh-integration-skillforge-multiclient/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { EvolutionClientId, EvolutionScopeId } from './index.ts'

const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const clientId = z.string().min(1).transform(value => brandString<EvolutionClientId>(value))
const scopeId = z.string().min(1).transform(value => brandString<EvolutionScopeId>(value))
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** One durable assignment from a Session to a client and isolated evolution scope. */
export const clientBindingRecord = z.object({
  sessionId,
  clientId,
  scopeId,
  source: z.union([z.literal('explicit'), z.literal('session-fallback')]),
  createdAt: timestamp,
}).strict()
/** Stored Session-to-client assignment. */
export type ClientBindingRecord = z.infer<typeof clientBindingRecord>

/** One successful contiguous tool path observed for a bound client. */
export const clientEvidenceRecord = z.object({
  id: z.string().min(1),
  sessionId,
  clientId,
  scopeId,
  turn: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  toolPath: z.array(z.string().min(1)).min(1),
  createdAt: timestamp,
}).strict()
/** Stored multi-client path evidence. */
export type ClientEvidenceRecord = z.infer<typeof clientEvidenceRecord>

/** One path that met every configured client, Session, and support gate. */
export const sharedSkillRecord = z.object({
  id: z.string().min(1),
  scopeId,
  toolPath: z.array(z.string().min(1)).min(1),
  support: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  clientCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  evidenceIds: z.array(z.string().min(1)).min(1),
  updatedAt: timestamp,
}).strict()
/** Stored cross-client skill candidate. */
export type SharedSkillRecord = z.infer<typeof sharedSkillRecord>

/** Audit record for one scope-filtered prompt injection. */
export const sharedSkillInjectionRecord = z.object({
  id: z.string().min(1),
  sessionId,
  scopeId,
  skillIds: z.array(z.string().min(1)).min(1),
  createdAt: timestamp,
}).strict()
/** Stored prompt-injection audit entry. */
export type SharedSkillInjectionRecord = z.infer<typeof sharedSkillInjectionRecord>

/** Durable domain for bindings, evidence, qualified paths, and injection audits. */
export const skillforgeMulticlientDomainSpec = defineDomain({
  name: 'skillforge_multiclient',
  version: 1,
  tables: {
    bindings: domainTable<SessionId, ClientBindingRecord>(clientBindingRecord),
    evidence: domainTable<string, ClientEvidenceRecord>(clientEvidenceRecord),
    skills: domainTable<string, SharedSkillRecord>(sharedSkillRecord),
    injections: domainTable<string, SharedSkillInjectionRecord>(sharedSkillInjectionRecord),
  },
})
