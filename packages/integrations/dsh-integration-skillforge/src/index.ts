/**
 * SkillForge-in-DSH: an in-process, port-free learning loop over agent
 * sessions.
 *
 * Pipeline (ported from the SkillForge Python service, deterministic):
 *
 * ```
 * session/event (tool/call + tool/result)
 *   -> turn/end: trajectory record persisted (ctx.storageDomain)
 *   -> failed calls classified (keyword fallback classifier)
 *   -> failure records distilled into blocking precheck rules
 *   -> successful chains mined into skills (sliding window + Wilson CI)
 *   -> skills scored (success/latency/token/volume + idle decay)
 *   -> ACTIVE/CANARY skills surfaced via a system prompt section
 * guards:
 *   -> tools/pre-execute: learned required parameters enforced
 *   -> tools/post-execute: recovery guidance attached to failures
 * ```
 *
 * Configure in a DSH profile `cordis.patch.yml`:
 *
 * ```yaml
 * - id: skillforge
 *   name: '@deepseek-ai/dsh-integration-skillforge'
 *   config:
 *     projectName: 'my-project'
 * ```
 *
 * @module @deepseek-ai/dsh-integration-skillforge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PreToolDecision, PostToolDecision } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import { classifyFailure, missingRequiredParameters } from './classifier.js'
import { distillRules } from './distiller.js'
import { mineSkills } from './miner.js'
import { buildTemplate, templateKey, type ToolParameterTemplate } from './profiler.js'
import { recoveryAction, recoveryGuidance } from './recovery.js'
import { isUsable, scoreSkill } from './scoring.js'
import { enumViolations, parseToolSchema } from './schema.js'
import { skillforgeDomainSpec, type FailureRecord, type InjectionRecord, type RuleRecord, type SkillRecord, type SkillRevisionRecord, type TrajectoryRecord, type VerificationRecord } from './spec.js'
import { trackerFor } from './tracker.js'
import { SkillStatus, type TurnCall, type TurnRecord } from './types.js'
import { verifyPostconditions, verificationGuidance, type PostconditionConfig, type VerificationFailure } from './verifier.js'

/** Plugin config; defaults make every feature opt-out. */
export interface SkillForgeConfig {
  /** Disable the entire plugin without removing the row. Enforced in-code
   *  (not just by the Loader) so a hot-reloaded row cannot re-activate it. */
  disabled?: boolean
  /** Scenario label attached to every stored trajectory (the Python `scenario`). */
  projectName?: string
  /** Persist turns as trajectories and run the learning pipeline. */
  collectTrajectories?: boolean
  /** Deny tool calls that miss parameters learned as required. */
  ruleGuard?: boolean
  /** Attach classification + repair guidance to failed tool results. */
  recoveryHints?: boolean
  /** Surface ACTIVE/CANARY skills in a system prompt section. */
  skillInjection?: boolean
  /**
   * Postcondition checks evaluated at each turn end. Failures are stored,
   * injected as guidance on the next step, and block the failed turn's chains
   * from being mined as successful skills.
   */
  postconditions?: PostconditionConfig[]
  /** Mining thresholds (port of SkillMiner defaults). */
  minSupport?: number
  minPathLength?: number
  maxPathLength?: number
  /**
   * Cross-session evidence threshold for skill injection: a skill must be
   * seen in at least this many distinct sessions before it reaches the
   * prompt (single-session chains are overfit noise).
   */
  minSessionsForInjection?: number
  /** Cap on stored trajectories (oldest pruned first). */
  maxStoredTrajectories?: number
  /** Minimum interval between mining runs in ms. */
  minMiningIntervalMs?: number
  /**
   * Manual status pins applied after every mining run (last writer wins).
   * The skill bank is derived state: without a pin, the next mining run
   * re-derives whatever was rolled back. Set e.g. `offline` to retire a
   * bad skill durably, `active` to promote a candidate across the gate.
   */
  skillOverrides?: Record<string, SkillStatus>
  /** Revisions kept per skill name (oldest pruned first). */
  maxRevisionsPerSkill?: number
  /**
   * Skill name → snapshot revision to restore. Re-applied before every
   * mining run and the name is excluded from re-derivation while the
   * entry stays, so the restore is durable. A revision whose snapshot is
   * null (creation) rolls back to deleting the skill.
   */
  skillRollback?: Record<string, number>
}

interface ResolvedConfig {
  disabled: boolean
  projectName: string
  collectTrajectories: boolean
  ruleGuard: boolean
  recoveryHints: boolean
  skillInjection: boolean
  postconditions: PostconditionConfig[]
  minSupport: number
  minPathLength: number
  maxPathLength: number
  minSessionsForInjection: number
  maxStoredTrajectories: number
  minMiningIntervalMs: number
  skillOverrides: Record<string, SkillStatus>
  maxRevisionsPerSkill: number
  skillRollback: Record<string, number>
}

function resolveConfig(config: SkillForgeConfig = {}): ResolvedConfig {
  return {
    disabled: config.disabled ?? false,
    projectName: config.projectName ?? 'dsh',
    collectTrajectories: config.collectTrajectories ?? true,
    ruleGuard: config.ruleGuard ?? true,
    recoveryHints: config.recoveryHints ?? true,
    skillInjection: config.skillInjection ?? true,
    postconditions: config.postconditions ?? [],
    minSupport: config.minSupport ?? 2,
    minPathLength: config.minPathLength ?? 2,
    maxPathLength: config.maxPathLength ?? 5,
    minSessionsForInjection: config.minSessionsForInjection ?? 2,
    maxStoredTrajectories: config.maxStoredTrajectories ?? 500,
    minMiningIntervalMs: config.minMiningIntervalMs ?? 30000,
    skillOverrides: config.skillOverrides ?? {},
    maxRevisionsPerSkill: config.maxRevisionsPerSkill ?? 5,
    skillRollback: config.skillRollback ?? {},
  }
}

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'skillforge' } as const

/**
 * The SkillForge service. One instance owns the domain, the session-event
 * collector, the two tool-pipeline guards, and the prompt section.
 */
export class SkillForgeService extends Service {
  static inject = ['storageDomain', 'systemPrompt', 'tools']

  private readonly config: ResolvedConfig
  private trajectories?: KvTable<string, TrajectoryRecord>
  private failures?: KvTable<string, FailureRecord>
  private rules?: KvTable<string, RuleRecord>
  private skills?: KvTable<string, SkillRecord>
  private verifications?: KvTable<string, VerificationRecord>
  private injections?: KvTable<string, InjectionRecord>
  private skillRevisions?: KvTable<string, SkillRevisionRecord>

  /** In-memory parameter-template cache, rebuilt when trajectories change. */
  private templateCache = new Map<string, ToolParameterTemplate>()
  private templatesDirty = true
  private lastMiningAt = 0

  /** Verification failures awaiting injection into the session's next step. */
  private readonly pendingVerifications = new Map<string, string[]>()

  /** Turns finalized but not yet durably ingested; drained on session/flush
   *  (the loop awaits flush, unlike the fire-and-forget emit path). */
  private readonly pendingIngestion = new Map<string, { record: TurnRecord; verificationFailures: VerificationFailure[] }[]>()

  /** Most recently observed session, for best-effort injection attribution
   *  (the prompt-section text provider carries no session identity). */
  private lastSessionId?: string
  /** Last injected skill-name set; skips duplicate injection-log writes. */
  private lastInjectionLog = ''

  /** Lossless JSONL mirror for headless runs (survives abrupt process exit). */
  private readonly mirrorPath = join(homedir(), '.dsh', 'storages', 'skillforge-events.jsonl')

  /**
   * Per-scope scenario whitelists (scenario coeffect). Scope keys are opaque
   * objects (the agent instance itself), so the mapping is registered at
   * runtime rather than through JSON config; unregistered scopes see all.
   */
  private readonly scopeScenarios = new WeakMap<object, readonly string[]>()

  /**
   * Declare which skill scenarios a scope may receive. Unregistered scopes
   * receive all scenarios.
   */
  setScopeScenarios(scope: object, scenarios: readonly string[]): void {
    this.scopeScenarios.set(scope, scenarios)
  }

  constructor(ctx: Context, config: SkillForgeConfig = {}) {
    super(ctx, 'skillforge')
    this.config = resolveConfig(config)
  }

  /** Open the domain and register every listener. */
  protected async [Service.init](): Promise<void> {
    const { config } = this
    // Enforced in-code: a `disabled: true` row must never open storage or
    // register any listener, even when a live patch reload re-activates it.
    if (config.disabled) {
      this.ctx.logger.info('[skillforge] disabled by config; no listeners registered')
      return
    }
    const domain = await this.ctx.storageDomain.open(skillforgeDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'skillforge: close domain')
    this.trajectories = domain.table('trajectories')
    this.failures = domain.table('failures')
    this.rules = domain.table('rules')
    this.skills = domain.table('skills')
    this.verifications = domain.table('verifications')
    this.injections = domain.table('injections')
    this.skillRevisions = domain.table('skill_revisions')

    this.replayMirror()
    this.registerCollector()
    if (config.ruleGuard) this.registerGuard()
    if (config.recoveryHints) this.registerRecovery()
    if (config.skillInjection) this.registerPromptSection()
    if (config.postconditions.length > 0) {
      this.registerVerificationInjection()
      this.ctx.logger.info('[skillforge] postcondition verification enabled (%d checks)', config.postconditions.length)
    }
  }

  /** Synchronous JSONL mirror append — the write-ahead log. */
  private appendMirror(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.mirrorPath, JSON.stringify(entry) + '\n')
    } catch (error) {
      console.error('[skillforge] mirror write failed:', String(error))
    }
  }

  /**
   * Write-ahead-log replay: the JSONL mirror records every turn
   * synchronously, but the domain's queued writes can be cut by a headless
   * hard exit (nothing drains the chain). Each new process heals the
   * trajectories table from the log; puts are idempotent per key, and the
   * per-line scenario is preserved so S0/S3 isolation survives replay.
   */
  private replayMirror(): void {
    const table = this.trajectories
    const skillsTable = this.skills
    const revisionsTable = this.skillRevisions
    if (!table) return
    try {
      if (!existsSync(this.mirrorPath)) return
      const lines = readFileSync(this.mirrorPath, 'utf8').split('\n')
    let replayed = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const entry = JSON.parse(trimmed) as {
          scenario?: string
          ts?: number
          record?: TurnRecord
          verificationFailures?: VerificationFailure[]
          type?: string
          skill?: SkillRecord
          revision?: SkillRevisionRecord
        }
        if (entry.type === 'skill' && entry.skill?.name !== undefined && skillsTable !== undefined) {
          void skillsTable.put(entry.skill.name, entry.skill)
          continue
        }
        if (entry.type === 'revision' && entry.revision?.id !== undefined && revisionsTable !== undefined) {
          void revisionsTable.put(entry.revision.id, entry.revision)
          continue
        }
        const record = entry.record
        if (!record?.sessionId || !Array.isArray(record.calls)) continue
        const trajectory: TrajectoryRecord = {
          sessionId: record.sessionId,
          turn: record.turn,
          scenario: entry.scenario ?? this.config.projectName,
          goal: record.goal ?? '',
          plannerTrace: record.plannerTrace ?? [],
          calls: record.calls,
          createdAt: entry.ts ?? Date.now(),
          verificationFailures: entry.verificationFailures?.length ?? 0,
        }
        void table.put(`${record.sessionId}:turn${record.turn}`, trajectory)
        replayed += 1
      } catch {
        // Malformed mirror line: replay is best-effort.
      }
    }
    if (replayed > 0) {
      this.templatesDirty = true
      this.ctx.logger.info('[skillforge] mirror replayed %d turns into trajectories', replayed)
    }
    } catch (error) {
      this.ctx.logger.warn('skillforge: mirror replay failed: %o', error)
    }
  }

  // ---- 1. collector: session events -> trajectories/failures/rules/skills ----

  private registerCollector(): void {
    this.ctx.on('session/event', (session, event) => {
      this.lastSessionId = String(session.header.id)
      const tracker = trackerFor(session)
      tracker.handleEvent(event)
      if (event.type !== 'turn/end') return
      const record = tracker.finalizeTurn(event.data.turn)
      if (!record || !this.config.collectTrajectories) return
      // Synchronous verification on the emit path: execFileSync blocks
      // briefly but guarantees execution before a headless process exits
      // (async fire-and-forget work was being killed mid-flight).
      const verificationFailures = this.config.postconditions.length > 0
        ? verifyPostconditions(this.config.postconditions)
        : []
      if (verificationFailures.length > 0) {
        this.pendingVerifications.set(
          record.sessionId,
          verificationFailures.map(verificationGuidance),
        )
        this.ctx.logger.warn(
          'skillforge: verification failed at turn %s (%d checks)',
          record.turn, verificationFailures.length,
        )
        // Enqueue the durable records immediately (no await) so they land
        // before a headless process exits.
        const taskId = `${record.sessionId}:turn${record.turn}`
        const table = this.verifications
        if (table) {
          for (const failure of verificationFailures) {
            const verification: VerificationRecord = {
              id: `${taskId}:${failure.kind}:${Date.now()}`,
              sessionId: record.sessionId,
              turn: record.turn,
              kind: failure.kind,
              target: failure.target,
              expected: failure.expected,
              message: failure.message,
              createdAt: Date.now(),
            }
            void table.put(verification.id, verification)
          }
        }
      }
      // Durable ingestion on the sync emit path (fire-and-forget): the
      // flush-tail variant lost the exit race in headless runs, while
      // emit-time void puts (verifications above) land reliably — same
      // channel, same survival window. Puts are idempotent per taskId, so
      // a late flush re-drain is harmless.
      void this.ingestTurn(record, verificationFailures)

      // Verified-clean turn: start mining eagerly on the sync emit path. The
      // mining read hits in-memory tables (void puts are already visible) and
      // its result puts queue on the write chain — giving them the same
      // survival window as the trajectory writes. In the async ingestTurn
      // tail they were killed by headless shutdown every time.
      if (verificationFailures.length === 0) {
        const now = Date.now()
        if (now - this.lastMiningAt >= this.config.minMiningIntervalMs) {
          this.lastMiningAt = now
          void this.runMining()
        }
      }

      // Lossless synchronous mirror: the domain may close before async writes
      // drain during headless shutdown; appendFileSync always lands.
      this.appendMirror({ scenario: this.config.projectName, ts: Date.now(), record, verificationFailures })
    })

    this.ctx.on('session/flush', (session) => {
      // Ingestion now fires at turn/end (see the collector); this drain is a
      // safety net for anything still queued — puts are idempotent per key.
      const queue = this.pendingIngestion.get(String(session.header.id))
      if (!queue || queue.length === 0) return
      this.pendingIngestion.set(String(session.header.id), [])
      const pending = queue.splice(0)
      for (const { record, verificationFailures } of pending) {
        this.ingestTurn(record, verificationFailures)
      }
    })
  }

  /**
   * Fire-and-forget durable ingestion. Every put is launched without
   * awaiting: awaited put chains were cut by headless shutdown mid-flight
   * (the first await parks the continuation on a later tick that never
   * runs), while void puts — verifications empirically — land reliably on
   * the same emit path. Puts are idempotent per key; re-drains are
   * harmless.
   */
  private ingestTurn(
    record: TurnRecord,
    verificationFailures: VerificationFailure[] = [],
  ): void {
    const { config, trajectories, failures, rules } = this
    if (!trajectories || !failures || !rules) return

    const taskId = `${record.sessionId}:turn${record.turn}`
    try {
      const trajectory: TrajectoryRecord = {
        sessionId: record.sessionId,
        turn: record.turn,
        scenario: config.projectName,
        goal: record.goal,
        plannerTrace: record.plannerTrace,
        calls: record.calls,
        createdAt: Date.now(),
        verificationFailures: verificationFailures.length,
      }
      void trajectories.put(taskId, trajectory)
      this.templatesDirty = true
      this.pruneTrajectories()

      const newFailures: FailureRecord[] = []
      for (const call of record.calls) {
        if (call.success || call.errorMessage === null) continue
        const classification = classifyFailure({
          toolName: call.toolName,
          scenario: config.projectName,
          parameters: call.parameters,
          errorMessage: call.errorMessage,
          context: record.plannerTrace.join(' '),
        })
        const failure: FailureRecord = {
          id: `${taskId}:${call.callId}`,
          toolName: call.toolName,
          scenario: config.projectName,
          failureType: classification.failureType,
          parameters: call.parameters,
          errorMessage: call.errorMessage,
          context: record.plannerTrace.join(' ').slice(0, 2000),
          createdAt: Date.now(),
        }
        newFailures.push(failure)
        void failures.put(failure.id, failure)
      }

      if (newFailures.length > 0) {
        for (const rule of distillRules(newFailures)) {
          void rules.put(rule.name, rule)
        }
      }
    } catch (error) {
      this.ctx.logger.warn('skillforge: turn ingestion failed: %o', error)
    }
  }

  private pruneTrajectories(): void {
    const table = this.trajectories
    if (!table) return
    const cap = this.config.maxStoredTrajectories
    if (table.size <= cap) return
    const entries = [...table.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    const overflow = table.size - cap
    for (const [key] of entries.slice(0, overflow)) {
      void table.delete(key)
    }
  }

  /**
   * Synchronous mining pass: reads the in-memory table views, fires every
   * write as void (awaited put chains were cut by headless exits), and
   * mirrors each landed skill so the next process can replay anything the
   * write chain lost.
   */
  private runMining(): void {
    const { trajectories, skills, config } = this
    if (!trajectories || !skills) return
    try {
      const all = [...trajectories.entries()].map(([, record]) => record)
      const mined = mineSkills(all, {
        minSupport: config.minSupport,
        minPathLength: config.minPathLength,
        maxPathLength: config.maxPathLength,
        scenario: config.projectName,
      })
      const existingSkills = new Map(skills.entries())
      const existingRevisions = this.skillRevisions
        ? new Map(this.skillRevisions.entries())
        : new Map<string, SkillRevisionRecord>()
      const frozen = new Set<string>()
      for (const [name, revision] of Object.entries(config.skillRollback)) {
        frozen.add(name)
        const snapshot = existingRevisions.get(`${name}:${revision}`)
        if (!snapshot) {
          this.ctx.logger.warn('skillforge: rollback %s:%s not found', name, revision)
          continue
        }
        if (snapshot.record === null) void skills.delete(name)
        else {
          const restored = { ...snapshot.record, updatedAt: Date.now() }
          void skills.put(name, restored)
          // WAL: a lost restore would be silently overwritten by the next
          // replay of older mined-skill lines, so the restore logs too.
          this.appendMirror({ type: 'skill', scenario: config.projectName, ts: Date.now(), skill: restored })
        }
      }
      for (const skill of mined) {
        if (frozen.has(skill.name)) continue // 冻结,不重挖
        const scored = scoreSkill(skill, Date.now())
        // Manual pin (G4): overrides win over mining/scoring, so a rolled
        // back status survives the next re-derivation from trajectories.
        const override = config.skillOverrides[skill.name]
        const status = override ?? scored.status
        // Snapshot the overwritten record before it is replaced (G4 audit
        // trail). A null snapshot marks first creation; rolling back a
        // creation means deleting the skill.
        const previous = existingSkills.get(skill.name) ?? null
        if (this.skillRevisions) {
          let max = 0
          for (const [key] of existingRevisions) {
            if (!key.startsWith(`${skill.name}:`)) continue
            const value = Number(key.slice(skill.name.length + 1))
            if (Number.isFinite(value) && value > max) max = value
          }
          const revisionRecord: SkillRevisionRecord = {
            id: `${skill.name}:${max + 1}`,
            skillName: skill.name,
            revision: max + 1,
            record: previous,
            createdAt: Date.now(),
          }
          void this.skillRevisions.put(revisionRecord.id, revisionRecord)
          // WAL: rollback targets must survive exits to be usable later.
          this.appendMirror({ type: 'revision', scenario: config.projectName, ts: Date.now(), revision: revisionRecord })
          existingRevisions.set(revisionRecord.id, revisionRecord)
        }
        const updated = { ...skill, status }
        void skills.put(skill.name, updated)
        this.appendMirror({ type: 'skill', scenario: config.projectName, ts: Date.now(), skill: updated })
      }
      this.pruneSkillRevisions()
    } catch (error) {
      this.ctx.logger.warn('skillforge: mining failed: %o', error)
    }
  }

  /** Next revision number for a skill: max existing + 1 (small tables, a scan is fine). */
  private pruneSkillRevisions(): void {
    const table = this.skillRevisions
    const cap = this.config.maxRevisionsPerSkill
    if (!table || cap <= 0) return
    const keysByName = new Map<string, string[]>()
    for (const [key, record] of table.entries()) {
      const list = keysByName.get(record.skillName)
      if (list) list.push(key)
      else keysByName.set(record.skillName, [key])
    }
    for (const [, keys] of keysByName) {
      const ordered = keys.sort((a, b) =>
        Number(a.slice(a.lastIndexOf(':') + 1)) - Number(b.slice(b.lastIndexOf(':') + 1)))
      for (const key of ordered.slice(0, Math.max(0, ordered.length - cap))) {
        void table.delete(key)
      }
    }
  }

  // ---- 2. guard: schema-required + learned-required + enum enforcement ----

  private registerGuard(): void {
    this.ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const arguments_ = exec.arguments as Record<string, unknown>

      // Tool's own declared JSON Schema: required keys and enum sets are
      // enforceable from the very first call, no samples needed.
      const definition = this.ctx.tools.get(exec.name, exec.agent ?? undefined)
      const schema = parseToolSchema(definition?.parameters)

      const template = this.ensureTemplates(exec.name)
      const learnedRequired = template?.requiredKeys ?? []
      const sampleCount = template?.sampleCount ?? 0

      const missingSchema = missingRequiredParameters(arguments_, schema.required)
      const missingLearned = missingRequiredParameters(arguments_, learnedRequired)
      const enumKeys = enumViolations(arguments_, schema)

      if (missingSchema.length > 0) {
        this.ctx.logger.warn(
          'skillforge: blocked %s (missing or empty schema-required parameters: %s)',
          exec.name, missingSchema.join(', '),
        )
        return {
          kind: 'deny',
          reason: `SkillForge precheck: ${exec.name} is missing (or passed empty) required parameter(s) ${missingSchema.join(', ')} declared by its tool schema. Repair hint: provide a non-empty value before retrying.`,
        }
      }
      if (missingLearned.length > 0) {
        this.ctx.logger.warn(
          'skillforge: blocked %s (missing or empty empirically-required parameters: %s)',
          exec.name, missingLearned.join(', '),
        )
        return {
          kind: 'deny',
          reason: `SkillForge precheck: ${exec.name} is missing (or passed empty) parameter(s) ${missingLearned.join(', ')} present in all ${sampleCount} successful calls. Repair hint: provide a non-empty value before retrying.`,
        }
      }
      if (enumKeys.length > 0) {
        const detail = enumKeys.map(key => {
          const spec = schema.properties[key]
          return `${key} must be one of [${(spec?.enum ?? []).map(value => JSON.stringify(value)).join(', ')}]`
        }).join('; ')
        this.ctx.logger.warn('skillforge: blocked %s (enum violations: %s)', exec.name, enumKeys.join(', '))
        return {
          kind: 'deny',
          reason: `SkillForge precheck: ${exec.name} argument value out of allowed set — ${detail}. Repair hint: normalize parameter types before retrying.`,
        }
      }
      return next()
    })
  }

  private ensureTemplates(toolName: string): ToolParameterTemplate | undefined {
    if (this.templatesDirty) {
      this.rebuildTemplates()
      this.templatesDirty = false
    }
    return this.templateCache.get(templateKey(toolName, this.config.projectName))
  }

  private rebuildTemplates(): void {
    const table = this.trajectories
    this.templateCache.clear()
    if (!table) return
    const callsByTool = new Map<string, TurnCall[]>()
    for (const [, record] of table.entries()) {
      for (const call of record.calls) {
        if (!call.success) continue
        const key = templateKey(call.toolName, this.config.projectName)
        const list = callsByTool.get(key)
        const turnCall: TurnCall = {
          callId: '',
          toolName: call.toolName,
          parameters: call.parameters,
          startedAt: call.startedAt,
          endedAt: call.endedAt,
          latencyMs: call.latencyMs,
          success: call.success,
          resultSummary: call.resultSummary,
          errorMessage: call.errorMessage,
        }
        if (list) list.push(turnCall)
        else callsByTool.set(key, [turnCall])
      }
    }
    for (const [key, calls] of callsByTool) {
      const parts = key.split('::')
      this.templateCache.set(
        key,
        buildTemplate(calls, parts[1] ?? 'unknown', parts[0] ?? ''),
      )
    }
  }

  // ---- 3. recovery: guidance on failed tool results -------------------------

  private registerRecovery(): void {
    this.ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
      const downstream = await next()

      const contentText = result.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join(' ')

      // Tool-level failure OR bash-style command-level failure: either an
      // expanded "[exit code: N]" marker or the literal
      // "Command failed with exit code $?" form.
      const exitMatch = contentText.match(/\[exit code: (\d+)\]/)
      const unknownExit = contentText.includes('Command failed with exit code')
      const commandFailed = (exitMatch != null && exitMatch[1] !== '0') || unknownExit
      if (!result.isError && !commandFailed) return downstream

      const errorMessage = contentText || result.error?.message || String(result.error ?? '')
      const classification = classifyFailure({
        toolName: exec.name,
        scenario: this.config.projectName,
        parameters: exec.arguments as Record<string, unknown>,
        errorMessage,
        context: '',
      })
      const action = recoveryAction(classification.failureType)
      const guidance = recoveryGuidance(classification.failureType, action, exec.name, errorMessage)

      const context: UserMessage = createUserMessage({
        content: [{ type: 'text', text: guidance }],
        source: PLUGIN_SOURCE,
      })
      return {
        ...downstream,
        additionalContexts: [...(downstream.additionalContexts ?? []), context],
      }
    })
  }

  // ---- 4. prompt section: surface usable skills -----------------------------

  // ---- 4. verification feedback: inject failed-postcondition guidance ------

  private registerVerificationInjection(): void {
    this.ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream

      const pending = this.pendingVerifications.get(String(agent.session.header.id))
      if (!pending || pending.length === 0) return downstream
      this.pendingVerifications.delete(String(agent.session.header.id))

      const context: UserMessage = createUserMessage({
        content: [{ type: 'text', text: pending.join('\n') }],
        source: PLUGIN_SOURCE,
      })
      return {
        ...downstream,
        messages: [...downstream.messages, context],
      }
    })
  }

  // ---- 5. prompt section: surface usable skills -----------------------------

  private registerPromptSection(): void {
    this.ctx.systemPrompt.section({
      name: 'skillforge:skills',
      order: 550,
      text: (context) => this.skillsSectionText(context),
    })
  }

  private skillsSectionText(context?: AssembleContext): string {
    const table = this.skills
    if (!table || table.size === 0) return ''
    const minSessions = this.config.minSessionsForInjection
    // Scenario coeffect: a registered scope only receives skills whose
    // scenario is in its whitelist; unregistered scopes (and the global
    // scope) receive all.
    const allowed = context?.scope !== undefined
      ? this.scopeScenarios.get(context.scope)
      : undefined
    const usable = [...table.entries()]
      .map(([, skill]) => skill)
      .filter(skill => isUsable(skill.status as SkillStatus))
      // Cross-session evidence threshold: single-session chains were
      // overfit noise (stale file paths, task-specific todos) that derailed
      // small models.
      .filter(skill => uniqueSessions(skill) >= minSessions)
      .filter(skill => allowed === undefined || allowed.includes(skill.scenario))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8)
    if (usable.length === 0) return ''

    // Injection audit log (G3): record what was surfaced so evaluation can
    // check non-interference (no stale task parameters, per-session diff).
    // Writes are deduped per skill-name set and fire-and-forget, mirroring
    // the verifications writes on the emit path.
    const injectionsTable = this.injections
    const names = usable.map(skill => skill.name).sort()
    const signature = names.join(',')
    if (injectionsTable && signature !== this.lastInjectionLog) {
      this.lastInjectionLog = signature
      const record: InjectionRecord = {
        sessionId: this.lastSessionId,
        skillNames: names,
        createdAt: Date.now(),
      }
      void injectionsTable.put(`${record.createdAt}:${record.sessionId ?? 'unknown'}`, record)
    }

    // De-parameterized: only the chain shape is injected. Concrete argument
    // values from past runs poisoned unrelated tasks.
    const lines = usable.map(skill =>
      `- ${skill.scenario}: ${skill.toolPath.join(' -> ')} (support=${skill.support}, sessions=${uniqueSessions(skill)}, confidence=${(skill.confidence * 100).toFixed(0)}%).`,
    )
    return [
      'Learned tool-call patterns from past successful sessions:',
      ...lines,
      'Prefer these call chains for matching tasks; they skip re-planning.',
    ].join('\n')
  }
}

/** Count the distinct sessions behind a skill's evidence. */
function uniqueSessions(skill: SkillRecord): number {
  return new Set(skill.sourceTaskIds.map(id => id.split(':turn')[0] ?? id)).size
}

export default SkillForgeService
