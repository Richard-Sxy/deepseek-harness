import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SkillForgeMulticlientService, {
  EvolutionClientId,
  EvolutionScopeId,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(
  config: ConstructorParameters<typeof SkillForgeMulticlientService>[1] = {},
  pool = new MemoryMediaPool(),
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SkillForgeMulticlientService, config)
  return { ctx, service: ctx.skillforgeMulticlient }
}

function successfulPath(session: Session, names: readonly string[], turn = 1): void {
  session.append('turn/start', { turn })
  names.forEach((name, index) => {
    const callId = ToolCallId(`${session.id}-${turn}-${index}`)
    session.append('tool/call', { turn, step: 1, callId, name, arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function promptAgent(session: Session): Agent {
  return { id: session.id } as Agent
}

describe('SkillForge multi-client coordination', () => {
  it('requires distinct clients and Sessions before promoting a path', async () => {
    const { ctx, service } = await harness({
      unboundSessionPolicy: 'exclude',
      minClients: 2,
      minSessions: 2,
      minSupport: 2,
      minPathLength: 2,
      maxPathLength: 2,
    })
    const scope = EvolutionScopeId('team-red')
    const first = ctx.sessions.create(SessionId('red-a'))
    const second = ctx.sessions.create(SessionId('red-b'))
    await Promise.all([
      service.bindSession(first.id, { clientId: EvolutionClientId('client-a'), scopeId: scope }),
      service.bindSession(second.id, { clientId: EvolutionClientId('client-a'), scopeId: scope }),
    ])

    successfulPath(first, ['read', 'summarize'])
    successfulPath(second, ['read', 'summarize'])
    await ctx.sessions.flush(second)
    expect(service.snapshot(scope)).toMatchObject({
      evidenceCount: 2,
      clientCount: 1,
      sessionCount: 2,
      skills: [],
    })

    const third = ctx.sessions.create(SessionId('red-c'))
    await service.bindSession(third.id, { clientId: EvolutionClientId('client-b'), scopeId: scope })
    successfulPath(third, ['read', 'summarize'])
    await ctx.sessions.flush(third)

    expect(service.snapshot(scope)).toMatchObject({
      evidenceCount: 3,
      clientCount: 2,
      sessionCount: 3,
      skills: [{
        toolPath: ['read', 'summarize'],
        support: 3,
        clientCount: 2,
        sessionCount: 3,
      }],
    })
  })

  it('isolates prompt injection by evolution scope and rejects evidence rebinds', async () => {
    const { ctx, service } = await harness({
      unboundSessionPolicy: 'exclude',
      minClients: 1,
      minSessions: 1,
      minSupport: 1,
      minPathLength: 2,
      maxPathLength: 2,
    })
    const red = EvolutionScopeId('team-red')
    const blue = EvolutionScopeId('team-blue')
    const redSession = ctx.sessions.create(SessionId('red'))
    const blueSession = ctx.sessions.create(SessionId('blue'))
    await service.bindSession(redSession.id, { clientId: EvolutionClientId('red-client'), scopeId: red })
    await service.bindSession(blueSession.id, { clientId: EvolutionClientId('blue-client'), scopeId: blue })
    successfulPath(redSession, ['read', 'summarize'])
    successfulPath(blueSession, ['search', 'fetch'])
    await ctx.sessions.flush(blueSession)

    const redAgent = promptAgent(redSession)
    const redPrompt = await ctx.systemPrompt.assemble({ scope: redAgent, agent: redAgent })
    const redText = redPrompt.sections.find(section => section.name === 'skillforge:multiclient-skills')?.text
    expect(redText).toContain('read -> summarize')
    expect(redText).not.toContain('search -> fetch')

    const blueAgent = promptAgent(blueSession)
    const bluePrompt = await ctx.systemPrompt.assemble({ scope: blueAgent, agent: blueAgent })
    const blueText = bluePrompt.sections.find(section => section.name === 'skillforge:multiclient-skills')?.text
    expect(blueText).toContain('search -> fetch')
    expect(blueText).not.toContain('read -> summarize')

    await expect(service.bindSession(redSession.id, {
      clientId: EvolutionClientId('other-client'),
      scopeId: blue,
    })).rejects.toThrow('immutable SkillForge client binding')
  })

  it('persists fallback bindings and uses one Session as one demo client', async () => {
    const { ctx, service } = await harness({
      defaultScope: 'demo',
      minClients: 2,
      minSessions: 2,
      minSupport: 2,
      minPathLength: 2,
      maxPathLength: 2,
    })
    const first = ctx.sessions.create(SessionId('demo-a'))
    const second = ctx.sessions.create(SessionId('demo-b'))
    successfulPath(first, ['list', 'open'])
    successfulPath(second, ['list', 'open'])
    await ctx.sessions.flush(second)

    expect(service.bindingOf(first.id)).toMatchObject({
      clientId: 'session:demo-a',
      scopeId: 'demo',
      source: 'session-fallback',
    })
    expect(service.snapshot(EvolutionScopeId('demo')).skills).toHaveLength(1)
  })

  it('recomputes persisted skills under stricter startup gates', async () => {
    const pool = new MemoryMediaPool()
    const firstHarness = await harness({
      unboundSessionPolicy: 'exclude',
      minClients: 1,
      minSessions: 1,
      minSupport: 1,
      minPathLength: 2,
      maxPathLength: 2,
    }, pool)
    const scope = EvolutionScopeId('persistent-team')
    const session = firstHarness.ctx.sessions.create(SessionId('persistent-session'))
    await firstHarness.service.bindSession(session.id, {
      clientId: EvolutionClientId('only-client'),
      scopeId: scope,
    })
    successfulPath(session, ['read', 'summarize'])
    await firstHarness.ctx.sessions.flush(session)
    expect(firstHarness.service.snapshot(scope).skills).toHaveLength(1)
    await firstHarness.ctx.fiber.dispose()

    const secondHarness = await harness({
      unboundSessionPolicy: 'exclude',
      minClients: 2,
      minSessions: 1,
      minSupport: 1,
      minPathLength: 2,
      maxPathLength: 2,
    }, pool)
    expect(secondHarness.service.snapshot(scope)).toMatchObject({
      evidenceCount: 1,
      clientCount: 1,
      skills: [],
    })
  })
})
