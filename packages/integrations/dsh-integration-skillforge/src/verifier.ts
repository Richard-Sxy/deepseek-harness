/**
 * Postcondition verifier: catches "tool success ≠ task correctness" silent
 * failures (placeholder data, wrong program behavior, leftover debug code).
 * Port of the concept behind `app/services/run_verifier.py`, adapted to the
 * DSH plugin: checks are declared in config and evaluated in-process with
 * node:fs and a sandboxed-less bash subprocess at each turn end.
 * @module @deepseek-ai/dsh-integration-skillforge/verifier
 */

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export interface PostconditionConfig {
  /** Check kind. */
  kind: 'file_exists' | 'file_contains' | 'file_not_contains' | 'command_output_contains'
  /** File path (file_* kinds) or shell command (command_output_contains). */
  target: string
  /** Expected substring. */
  expected: string
  /** Human-readable message injected when the check fails. */
  message: string
}

export interface VerificationFailure {
  kind: string
  target: string
  expected: string
  message: string
}

/** Timeout for verification subprocesses (ms). */
const COMMAND_TIMEOUT_MS = 15000

/**
 * Evaluate all postconditions. Returns the failures; an empty array means
 * every check passed.
 */
export function verifyPostconditions(
  postconditions: PostconditionConfig[] | undefined,
): VerificationFailure[] {
  if (!postconditions || postconditions.length === 0) return []
  const failures: VerificationFailure[] = []
  for (const check of postconditions) {
    if (checkOne(check)) continue
    failures.push({
      kind: check.kind,
      target: check.target,
      expected: check.expected,
      message: check.message,
    })
  }
  return failures
}

function checkOne(check: PostconditionConfig): boolean {
  switch (check.kind) {
    case 'file_exists':
      return existsSync(check.target)
    case 'file_contains':
      return readText(check.target)?.includes(check.expected) ?? false
    case 'file_not_contains':
      return !(readText(check.target)?.includes(check.expected) ?? false)
    case 'command_output_contains': {
      try {
        const stdout = execFileSync('bash', ['-lc', check.target], {
          encoding: 'utf8',
          timeout: COMMAND_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return stdout.includes(check.expected)
      } catch (error) {
        // Non-zero exit or spawn failure: the command did not produce the
        // expected output.
        return false
      }
    }
    default:
      return true
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Render one verification failure as model-facing guidance text. */
export function verificationGuidance(failure: VerificationFailure): string {
  switch (failure.kind) {
    case 'file_exists':
      return `SkillForge verification failed: expected file \`${failure.target}\` to exist, but it does not. ${failure.message}`
    case 'file_contains':
      return `SkillForge verification failed: \`${failure.target}\` does not contain the expected content ("${failure.expected}"). ${failure.message}`
    case 'file_not_contains':
      return `SkillForge verification failed: \`${failure.target}\` still contains the unwanted content ("${failure.expected}"). ${failure.message}`
    case 'command_output_contains':
      return `SkillForge verification failed: \`${failure.target}\` did not produce the expected output ("${failure.expected}"). ${failure.message}`
    default:
      return `SkillForge verification failed on \`${failure.target}\`. ${failure.message}`
  }
}
