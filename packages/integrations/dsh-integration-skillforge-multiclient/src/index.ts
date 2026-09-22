/**
 * Multi-client evidence coordination for SkillForge. This companion plugin
 * leaves the base SkillForge implementation unchanged and adds durable client
 * identity, evolution-scope isolation, cross-client promotion, and scoped
 * prompt injection.
 * @module @deepseek-ai/dsh-integration-skillforge-multiclient
 */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import {
  skillforgeMulticlientDomainSpec,
  type ClientBindingRecord,
  type ClientEvidenceRecord,
  type SharedSkillInjectionRecord,
  type SharedSkillRecord,
} from './spec.ts'

export { skillforgeMulticlientDomainSpec } from './spec.ts'
export type {
  ClientBindingRecord,
  ClientEvidenceRecord,
  SharedSkillInjectionRecord,
  SharedSkillRecord,
} from './spec.ts'

/** Stable identity of one client contributing evidence. */
export type EvolutionClientId = Branded<'SkillForgeEvolutionClientId'>
/** Isolation key for one shared evolution pool. */
export type EvolutionScopeId = Branded<'SkillForgeEvolutionScopeId'>

/**
 * Validate and brand one client identity supplied by a trusted adapter.
 * @param value - Stable authenticated client identity.
 * @returns the validated compile-time-branded identity.
 */
export function EvolutionClientId(value: string): EvolutionClientId {
  return brandString<EvolutionClientId>(validatedIdentity(value, 'clientId'))
}

/**
 * Validate and brand one evolution-scope identity.
 * @param value - Stable tenant, team, or other isolation identity.
 * @returns the validated compile-time-branded identity.
 */
export function EvolutionScopeId(value: string): EvolutionScopeId {
  return brandString<EvolutionScopeId>(validatedIdentity(value, 'scopeId'))
}

/** Deployment settings for evidence admission, promotion, and retention. */
export interface Config {
  /** Scope assigned when a Session has no explicit binding. */
  defaultScope?: string
  /** Whether an unbound Session is excluded or treated as one fallback client. */
  unboundSessionPolicy?: 'exclude' | 'session-client'
  /** Distinct clients required before a path is injected. */
  minClients?: number
  /** Distinct Sessions required before a path is injected. */
  minSessions?: number
  /** Total path observations required before a path is injected. */
  minSupport?: number
  /** Shortest contiguous successful path retained as evidence. */
  minPathLength?: number
  /** Longest contiguous successful path retained as evidence. */
  maxPathLength?: number
  /** Maximum evidence records retained per evolution scope. */
  maxEvidencePerScope?: number
  /** Maximum qualified paths injected per evolution scope. */
  maxSkillsPerScope?: number
  /** Maximum injection audit records retained per evolution scope. */
  maxInjectionsPerScope?: number
  /** Maximum live Session trackers retained before the oldest entry is evicted. */
  maxTrackedSessions?: number
}

interface ResolvedConfig {
  readonly defaultScope: EvolutionScopeId
  readonly unboundSessionPolicy: 'exclude' | 'session-client'
  readonly minClients: number
  readonly minSessions: number
  readonly minSupport: number
  readonly minPathLength: number
  readonly maxPathLength: number
  readonly maxEvidencePerScope: number
  readonly maxSkillsPerScope: number
  readonly maxInjectionsPerScope: number
  readonly maxTrackedSessions: number
}

/** Trusted binding supplied by the client-facing gateway or another adapter. */
export interface ClientBinding {
  readonly clientId: EvolutionClientId
  readonly scopeId: EvolutionScopeId
}

/** Read-only operational view of one evolution scope. */
export interface EvolutionScopeSnapshot {
  readonly scopeId: EvolutionScopeId
  readonly evidenceCount: number
  readonly clientCount: number
  readonly sessionCount: number
  readonly skills: readonly SharedSkillRecord[]
}

interface ObservedCall {
  readonly callId: string
  readonly name: string
  outcome: 'pending' | 'success' | 'failure'
}

interface TurnTrace {
  readonly turn: number
  readonly calls: ObservedCall[]
}

interface SkillCandidate extends SharedSkillRecord {
  readonly signature: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillforgeMulticlient: SkillForgeMulticlientService
  }
}

const DEFAULTS = {
  scope: 'shared',
  minClients: 2,
  minSessions: 2,
  minSupport: 2,
  minPathLength: 2,
  maxPathLength: 5,
  maxEvidencePerScope: 2_000,
  maxSkillsPerScope: 16,
  maxInjectionsPerScope: 1_000,
  maxTrackedSessions: 256,
} as const

const positiveInteger = () => z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)

/** Multi-client coordinator service. */
export class SkillForgeMulticlientService extends Service {
  static inject = ['storageDomain', 'systemPrompt']

  static Config: z<Config> = z.object({
    defaultScope: z.string().default(DEFAULTS.scope),
    unboundSessionPolicy: z.union([z.const('exclude'), z.const('session-client')]).default('session-client'),
    minClients: positiveInteger().default(DEFAULTS.minClients),
    minSessions: positiveInteger().default(DEFAULTS.minSessions),
    minSupport: positiveInteger().default(DEFAULTS.minSupport),
    minPathLength: positiveInteger().default(DEFAULTS.minPathLength),
    maxPathLength: positiveInteger().default(DEFAULTS.maxPathLength),
    maxEvidencePerScope: positiveInteger().default(DEFAULTS.maxEvidencePerScope),
    maxSkillsPerScope: positiveInteger().default(DEFAULTS.maxSkillsPerScope),
    maxInjectionsPerScope: positiveInteger().default(DEFAULTS.maxInjectionsPerScope),
    maxTrackedSessions: positiveInteger().default(DEFAULTS.maxTrackedSessions),
  })

  private readonly resolved: ResolvedConfig
  private bindings?: KvTable<SessionId, ClientBindingRecord>
  private evidence?: KvTable<string, ClientEvidenceRecord>
  private skills?: KvTable<string, SharedSkillRecord>
  private injections?: KvTable<string, SharedSkillInjectionRecord>
  private readonly traces = new Map<SessionId, TurnTrace>()
  private readonly lastInjectionSignatures = new Map<SessionId, string>()
  private operationTail: Promise<void> = Promise.resolve()
  private backgroundFailure: Error | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skillforgeMulticlient')
    const minPathLength = config.minPathLength ?? DEFAULTS.minPathLength
    const maxPathLength = config.maxPathLength ?? DEFAULTS.maxPathLength
    if (maxPathLength < minPathLength) {
      throw new Error('maxPathLength must be greater than or equal to minPathLength')
    }
    this.resolved = {
      defaultScope: EvolutionScopeId(config.defaultScope ?? DEFAULTS.scope),
      unboundSessionPolicy: config.unboundSessionPolicy ?? 'session-client',
      minClients: validatedPositiveInteger(config.minClients ?? DEFAULTS.minClients, 'minClients'),
      minSessions: validatedPositiveInteger(config.minSessions ?? DEFAULTS.minSessions, 'minSessions'),
      minSupport: validatedPositiveInteger(config.minSupport ?? DEFAULTS.minSupport, 'minSupport'),
      minPathLength: validatedPositiveInteger(minPathLength, 'minPathLength'),
      maxPathLength: validatedPositiveInteger(maxPathLength, 'maxPathLength'),
      maxEvidencePerScope: validatedPositiveInteger(config.maxEvidencePerScope ?? DEFAULTS.maxEvidencePerScope, 'maxEvidencePerScope'),
      maxSkillsPerScope: validatedPositiveInteger(config.maxSkillsPerScope ?? DEFAULTS.maxSkillsPerScope, 'maxSkillsPerScope'),
      maxInjectionsPerScope: validatedPositiveInteger(config.maxInjectionsPerScope ?? DEFAULTS.maxInjectionsPerScope, 'maxInjectionsPerScope'),
      maxTrackedSessions: validatedPositiveInteger(config.maxTrackedSessions ?? DEFAULTS.maxTrackedSessions, 'maxTrackedSessions'),
    }
  }

  /** Open durable state and register collection, flush, and prompt effects. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(skillforgeMulticlientDomainSpec)
    this.ctx.effect(() => async () => {
      await this.operationTail
      await domain.close()
    }, 'skillforgeMulticlient.domainClose()')
    this.bindings = domain.table('bindings')
    this.evidence = domain.table('evidence')
    this.skills = domain.table('skills')
    this.injections = domain.table('injections')

    const scopes = new Set<EvolutionScopeId>()
    for (const [, record] of this.evidence.entries()) scopes.add(record.scopeId)
    for (const [, record] of this.skills.entries()) scopes.add(record.scopeId)
    for (const scopeId of scopes) {
      await this.pruneEvidence(scopeId)
      await this.rebuildScope(scopeId)
    }

    this.ctx.on('session/created', (session) => {
      if (this.resolved.unboundSessionPolicy === 'session-client') {
        this.enqueueBackground(() => this.ensureFallbackBinding(session))
      }
    })
    this.ctx.on('session/disposed', (session) => {
      this.traces.delete(session.id)
      this.lastInjectionSignatures.delete(session.id)
    })
    this.ctx.on('session/event', (session, event) => { this.observeEvent(session, event) })
    this.ctx.on('session/flush', async () => {
      await this.operationTail
      if (this.backgroundFailure !== undefined) throw this.backgroundFailure
    })
    this.ctx.systemPrompt.section({
      name: 'skillforge:multiclient-skills',
      order: 551,
      text: context => this.promptText(context),
    })
  }

  /**
   * Bind one Session to a trusted client and evolution scope. A conflicting
   * explicit binding is rejected. A fallback binding may be replaced only
   * before the Session contributes evidence.
   * @param sessionId - Session identity to bind.
   * @param binding - Trusted client and isolation identities.
   * @returns resolution after the binding is durable.
   */
  bindSession(sessionId: SessionId, binding: ClientBinding): Promise<void> {
    return this.enqueueOperation(async () => {
      const table = this.requireBindings()
      const current = table.get(sessionId)
      if (current !== undefined
        && current.clientId === binding.clientId
        && current.scopeId === binding.scopeId) {
        if (current.source === 'explicit') return
        await table.put(sessionId, { ...current, source: 'explicit' })
        return
      }
      if (current !== undefined) {
        const hasEvidence = [...this.requireEvidence().entries()]
          .some(([, record]) => record.sessionId === sessionId)
        if (current.source === 'explicit' || hasEvidence) {
          throw new Error(`Session '${sessionId}' already has an immutable SkillForge client binding`)
        }
      }
      await table.put(sessionId, {
        sessionId,
        clientId: binding.clientId,
        scopeId: binding.scopeId,
        source: 'explicit',
        createdAt: Date.now(),
      })
    })
  }

  /**
   * Read the durable binding of one Session.
   * @param sessionId - Session identity to inspect.
   * @returns a detached record or `undefined` when the Session is excluded.
   */
  bindingOf(sessionId: SessionId): ClientBindingRecord | undefined {
    const record = this.requireBindings().get(sessionId)
    return record === undefined ? undefined : structuredClone(record)
  }

  /**
   * Summarize durable evidence and qualified skills for one isolated scope.
   * @param scopeId - Evolution scope to inspect.
   * @returns a detached operational snapshot.
   */
  snapshot(scopeId: EvolutionScopeId): EvolutionScopeSnapshot {
    const evidence = [...this.requireEvidence().entries()]
      .map(([, record]) => record)
      .filter(record => record.scopeId === scopeId)
    const skills = [...this.requireSkills().entries()]
      .map(([, record]) => record)
      .filter(record => record.scopeId === scopeId)
      .sort(compareSkills)
      .map(record => structuredClone(record))
    return {
      scopeId,
      evidenceCount: evidence.length,
      clientCount: new Set(evidence.map(record => record.clientId)).size,
      sessionCount: new Set(evidence.map(record => record.sessionId)).size,
      skills,
    }
  }

  private observeEvent(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
        this.rememberTrace(session.id, { turn: event.data.turn, calls: [] })
        return
      case 'tool/call': {
        const trace = this.traces.get(session.id)
        if (trace?.turn !== event.data.turn) return
        trace.calls.push({ callId: String(event.data.callId), name: event.data.name, outcome: 'pending' })
        return
      }
      case 'tool/result': {
        const trace = this.traces.get(session.id)
        if (trace?.turn !== event.data.turn) return
        const callId = String(event.data.message.content[0].toolCallId)
        const call = trace.calls.find(candidate => candidate.callId === callId)
        if (call !== undefined) {
          call.outcome = event.data.message.content[0].isError ? 'failure' : 'success'
        }
        return
      }
      case 'turn/end': {
        const trace = this.traces.get(session.id)
        this.traces.delete(session.id)
        if (trace?.turn !== event.data.turn
          || event.data.reason.kind !== 'completed'
          || trace.calls.length < this.resolved.minPathLength
          || trace.calls.some(call => call.outcome !== 'success')) return
        this.enqueueBackground(() => this.ingestSuccessfulTurn(session, trace, event.time))
        return
      }
      default:
        return
    }
  }

  private rememberTrace(sessionId: SessionId, trace: TurnTrace): void {
    this.traces.delete(sessionId)
    this.traces.set(sessionId, trace)
    while (this.traces.size > this.resolved.maxTrackedSessions) {
      const oldest = this.traces.keys().next().value
      if (oldest === undefined) return
      this.traces.delete(oldest)
    }
  }

  private async ensureFallbackBinding(session: Session): Promise<void> {
    const table = this.requireBindings()
    if (table.get(session.id) !== undefined) return
    await table.put(session.id, {
      sessionId: session.id,
      clientId: EvolutionClientId(`session:${session.id}`),
      scopeId: this.resolved.defaultScope,
      source: 'session-fallback',
      createdAt: session.header.createdAt,
    })
  }

  private async ingestSuccessfulTurn(session: Session, trace: TurnTrace, createdAt: number): Promise<void> {
    let binding = this.requireBindings().get(session.id)
    if (binding === undefined && this.resolved.unboundSessionPolicy === 'session-client') {
      await this.ensureFallbackBinding(session)
      binding = this.requireBindings().get(session.id)
    }
    if (binding === undefined) return

    const names = trace.calls.map(call => call.name)
    const upper = Math.min(this.resolved.maxPathLength, names.length)
    for (let length = this.resolved.minPathLength; length <= upper; length += 1) {
      for (let start = 0; start + length <= names.length; start += 1) {
        const toolPath = names.slice(start, start + length)
        const id = `${session.id}:turn${trace.turn}:${start}:${length}`
        await this.requireEvidence().put(id, {
          id,
          sessionId: session.id,
          clientId: binding.clientId,
          scopeId: binding.scopeId,
          turn: trace.turn,
          start,
          toolPath,
          createdAt,
        })
      }
    }
    await this.pruneEvidence(binding.scopeId)
    await this.rebuildScope(binding.scopeId)
  }

  private async pruneEvidence(scopeId: EvolutionScopeId): Promise<void> {
    const records = [...this.requireEvidence().entries()]
      .filter(([, record]) => record.scopeId === scopeId)
      .sort((left, right) => left[1].createdAt - right[1].createdAt || left[0].localeCompare(right[0]))
    const excess = records.length - this.resolved.maxEvidencePerScope
    for (const [id] of records.slice(0, Math.max(0, excess))) {
      await this.requireEvidence().delete(id)
    }
  }

  private async rebuildScope(scopeId: EvolutionScopeId): Promise<void> {
    const groups = new Map<string, ClientEvidenceRecord[]>()
    for (const [, record] of this.requireEvidence().entries()) {
      if (record.scopeId !== scopeId) continue
      const signature = JSON.stringify(record.toolPath)
      const group = groups.get(signature)
      if (group === undefined) groups.set(signature, [record])
      else group.push(record)
    }

    const candidates: SkillCandidate[] = []
    for (const [signature, records] of groups) {
      const clients = new Set(records.map(record => record.clientId))
      const sessions = new Set(records.map(record => record.sessionId))
      if (records.length < this.resolved.minSupport
        || clients.size < this.resolved.minClients
        || sessions.size < this.resolved.minSessions) continue
      const first = records[0]
      if (first === undefined) continue
      const id = skillId(scopeId, signature)
      candidates.push({
        id,
        scopeId,
        toolPath: [...first.toolPath],
        support: records.length,
        clientCount: clients.size,
        sessionCount: sessions.size,
        evidenceIds: records.map(record => record.id).sort(),
        updatedAt: Math.max(...records.map(record => record.createdAt)),
        signature,
      })
    }
    candidates.sort(compareCandidates)
    const retained = candidates.slice(0, this.resolved.maxSkillsPerScope)
    const retainedIds = new Set(retained.map(candidate => candidate.id))
    for (const [id, skill] of this.requireSkills().entries()) {
      if (skill.scopeId === scopeId && !retainedIds.has(id)) await this.requireSkills().delete(id)
    }
    for (const { signature: _signature, ...record } of retained) {
      await this.requireSkills().put(record.id, record)
    }
  }

  private promptText(context: AssembleContext): string {
    const agent = context.agent
    if (agent === undefined) return ''
    const binding = this.requireBindings().get(agent.id)
    if (binding === undefined) return ''
    const skills = [...this.requireSkills().entries()]
      .map(([, skill]) => skill)
      .filter(skill => skill.scopeId === binding.scopeId)
      .sort(compareSkills)
      .slice(0, this.resolved.maxSkillsPerScope)
    if (skills.length === 0) return ''

    const signature = skills.map(skill => skill.id).join(',')
    if (this.lastInjectionSignatures.get(agent.id) !== signature) {
      this.lastInjectionSignatures.set(agent.id, signature)
      this.enqueueBackground(async () => {
        const createdAt = Date.now()
        const id = `injection:${randomUUID()}`
        await this.requireInjections().put(id, {
          id,
          sessionId: agent.id,
          scopeId: binding.scopeId,
          skillIds: skills.map(skill => skill.id),
          createdAt,
        })
        await this.pruneInjections(binding.scopeId)
      })
    }

    return [
      'Cross-client tool-call patterns verified in this evolution scope:',
      ...skills.map(skill => `- ${skill.toolPath.join(' -> ')} (clients=${skill.clientCount}, sessions=${skill.sessionCount}, support=${skill.support}).`),
      'Use these de-parameterized paths only when they fit the current task; choose arguments from current context.',
    ].join('\n')
  }

  private enqueueBackground(operation: () => Promise<void>): void {
    void this.enqueueOperation(operation).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error), { cause: error })
      this.backgroundFailure ??= failure
      this.ctx.logger.error('[skillforge-multiclient] background persistence failed: %s', String(failure))
    })
  }

  private async pruneInjections(scopeId: EvolutionScopeId): Promise<void> {
    const records = [...this.requireInjections().entries()]
      .filter(([, record]) => record.scopeId === scopeId)
      .sort((left, right) => left[1].createdAt - right[1].createdAt || left[0].localeCompare(right[0]))
    const excess = records.length - this.resolved.maxInjectionsPerScope
    for (const [id] of records.slice(0, Math.max(0, excess))) {
      await this.requireInjections().delete(id)
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.operationTail.then(operation)
    this.operationTail = job.then(() => undefined, () => undefined)
    return job
  }

  private requireBindings(): KvTable<SessionId, ClientBindingRecord> {
    if (this.bindings === undefined) throw new Error('SkillForge multi-client service is not initialized')
    return this.bindings
  }

  private requireEvidence(): KvTable<string, ClientEvidenceRecord> {
    if (this.evidence === undefined) throw new Error('SkillForge multi-client service is not initialized')
    return this.evidence
  }

  private requireSkills(): KvTable<string, SharedSkillRecord> {
    if (this.skills === undefined) throw new Error('SkillForge multi-client service is not initialized')
    return this.skills
  }

  private requireInjections(): KvTable<string, SharedSkillInjectionRecord> {
    if (this.injections === undefined) throw new Error('SkillForge multi-client service is not initialized')
    return this.injections
  }
}

function validatedIdentity(value: string, name: string): string {
  if (value.length === 0 || value.trim() !== value || value.length > 256) {
    throw new Error(`${name} must be a non-empty, trimmed string of at most 256 characters`)
  }
  return value
}

function validatedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function skillId(scopeId: EvolutionScopeId, signature: string): string {
  return `shared-path:${shortHash(JSON.stringify([scopeId, signature]))}`
}

function compareCandidates(left: SkillCandidate, right: SkillCandidate): number {
  return right.clientCount - left.clientCount
    || right.sessionCount - left.sessionCount
    || right.support - left.support
    || left.signature.localeCompare(right.signature)
}

function compareSkills(left: SharedSkillRecord, right: SharedSkillRecord): number {
  return right.clientCount - left.clientCount
    || right.sessionCount - left.sessionCount
    || right.support - left.support
    || left.id.localeCompare(right.id)
}

export default SkillForgeMulticlientService
