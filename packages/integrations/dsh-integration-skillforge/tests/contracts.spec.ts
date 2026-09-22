import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyFailure, missingRequiredParameters } from '../src/classifier.ts'
import { mineSkills } from '../src/miner.ts'
import { buildTemplate } from '../src/profiler.ts'
import { recoveryAction, recoveryGuidance } from '../src/recovery.ts'
import { enumViolations, parseToolSchema } from '../src/schema.ts'
import { isUsable, scoreSkill } from '../src/scoring.ts'
import type { TrajectoryRecord } from '../src/spec.ts'
import { FailureType, RepairAction, SkillStatus, type TurnCall } from '../src/types.ts'
import { verificationGuidance, verifyPostconditions } from '../src/verifier.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function call(
  toolName: string,
  parameters: Record<string, unknown>,
  success = true,
): TurnCall {
  return {
    callId: `${toolName}-call`,
    toolName,
    parameters,
    startedAt: 10,
    endedAt: 20,
    latencyMs: 10,
    success,
    resultSummary: success ? 'ok' : null,
    errorMessage: success ? null : 'failed',
  }
}

function trajectory(
  sessionId: string,
  verificationFailures = 0,
): TrajectoryRecord {
  return {
    sessionId,
    turn: 1,
    scenario: 'docs',
    goal: 'inspect and summarize',
    plannerTrace: [],
    calls: [
      call('read', { path: '/workspace/input.md' }),
      call('summarize', { format: 'brief' }),
    ],
    createdAt: 1,
    verificationFailures,
  }
}

describe('failure classification and parameter guards', () => {
  it('prioritizes a concrete sandbox denial over unrelated planner context', () => {
    const result = classifyFailure({
      toolName: 'write',
      scenario: 'docs',
      parameters: { path: '/workspace/output.md' },
      errorMessage: 'Sandbox policy requires escalation',
      context: 'The plan mentioned a missing required field earlier',
    })

    expect(result.failureType).toBe(FailureType.PERMISSION_DENIED)
    expect(result.signals).toContain('permission_keywords')
    expect(result.signals).not.toContain('parameter_keywords:context')
  })

  it('uses planner context only when the error text has no classification signal', () => {
    const result = classifyFailure({
      toolName: 'custom',
      scenario: 'docs',
      parameters: {},
      errorMessage: 'operation rejected',
      context: 'missing required field: path',
    })

    expect(result.failureType).toBe(FailureType.PARAMETER_ERROR)
    expect(result.signals).toContain('parameter_keywords:context')
  })

  it('treats absent and empty-string values as missing', () => {
    expect(missingRequiredParameters({ path: '', mode: 'read' }, ['path', 'mode', 'query']))
      .toEqual(['path', 'query'])
  })
})

describe('schema and learned parameter contracts', () => {
  it('extracts required keys and rejects values outside declared enums', () => {
    const schema = parseToolSchema({
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mode: { type: 'string', enum: ['read', 'write'], required: true },
      },
    })

    expect(schema.required).toEqual(['path', 'mode'])
    expect(enumViolations({ path: '/tmp/a', mode: 'delete' }, schema)).toEqual(['mode'])
  })

  it('learns required keys from successful calls and ignores failed calls', () => {
    const template = buildTemplate([
      call('fetch', { url: 'https://example.test/a', limit: 5 }),
      call('fetch', { url: 'https://example.test/b' }),
      call('fetch', { limit: 99 }, false),
    ], 'fetch', 'research')

    expect(template.sampleCount).toBe(2)
    expect(template.requiredKeys).toEqual(['url'])
    expect(template.constraints['limit']).toMatchObject({ required: false, sampleCount: 1 })
  })
})

describe('skill mining and scoring', () => {
  it('mines repeated contiguous paths but excludes postcondition failures', () => {
    const skills = mineSkills([
      trajectory('session-a'),
      trajectory('session-b'),
      trajectory('session-c', 1),
    ], {
      minSupport: 2,
      minPathLength: 2,
      maxPathLength: 2,
      scenario: 'docs',
    })

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      toolPath: ['read', 'summarize'],
      support: 2,
      sourceTaskIds: ['session-a:turn1', 'session-b:turn1'],
    })
    expect(isUsable(skills[0]!.status as SkillStatus)).toBe(true)
    expect(scoreSkill(skills[0]!, skills[0]!.updatedAt).score).toBeGreaterThan(0)
  })
})

describe('recovery and postcondition verification', () => {
  it('maps permission denials to an alternative-tool recommendation', () => {
    const action = recoveryAction(FailureType.PERMISSION_DENIED)

    expect(action).toBe(RepairAction.SWITCH_TOOL)
    expect(recoveryGuidance(FailureType.PERMISSION_DENIED, action, 'write'))
      .toContain('switch to an alternative tool')
  })

  it('checks files in an isolated temporary directory and renders a failed check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skillforge-contracts-'))
    temporaryRoots.push(root)
    const path = join(root, 'result.txt')
    await writeFile(path, 'stable output\n')

    const failures = verifyPostconditions([
      { kind: 'file_exists', target: path, expected: '', message: 'Create the result.' },
      { kind: 'file_contains', target: path, expected: 'stable', message: 'Keep the marker.' },
      { kind: 'file_not_contains', target: path, expected: 'output', message: 'Remove the word.' },
    ])

    expect(failures).toEqual([{
      kind: 'file_not_contains',
      target: path,
      expected: 'output',
      message: 'Remove the word.',
    }])
    expect(verificationGuidance(failures[0]!)).toContain('still contains the unwanted content')
  })
})
