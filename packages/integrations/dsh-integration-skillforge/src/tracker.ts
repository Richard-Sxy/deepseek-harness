/**
 * Session-event tracker: accumulates DSH session events per session/turn
 * into `TurnRecord`s. Tool calls are paired by `callId`; the goal comes from
 * the first user message of the turn; assistant texts become the planner
 * trace.
 * @module @deepseek-ai/dsh-integration-skillforge/tracker
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TurnCall, TurnRecord } from './types.js'

// 表示一次等待发起的工具调用
interface PendingCall {
  name: string
  arguments: string
  startTime: number
}

// 某一轮对话的“临时收集箱”
interface TurnAccumulator {
  turn: number
  goal: string
  plannerTrace: string[]
  pendingCalls: Map<string, PendingCall>
  completedCalls: TurnCall[]
}

// 会话轨迹
class SessionTracker {
  readonly sessionId: string  // 初始化后不能重新赋值
  readonly cwd: string | undefined
  readonly agentPreset: string | undefined
  private currentTurn = 0
  private turns = new Map<number, TurnAccumulator>()

  constructor(sessionId: string, cwd: string | undefined, agentPreset: string | undefined) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.agentPreset = agentPreset
  }

  // 根据事件类型进行函数调用
  handleEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        const { turn } = event.data
        this.currentTurn = turn
        this.ensureTurn(turn)
        break
      }
      case 'user/message': {
        // event.data IS the UserMessage (content blocks directly).
        const text = extractText(event.data.content)
        if (!text) break
        const acc = this.ensureTurn(this.currentTurn)
        if (!acc.goal) acc.goal = text
        break
      }
      case 'assistant/message': {
        const text = extractText(event.data.message?.content)
        if (!text) break
        this.ensureTurn(event.data.turn).plannerTrace.push(text)
        break
      }
      case 'tool/call': {
        const { turn, callId, name, arguments: rawArguments } = event.data
        this.ensureTurn(turn).pendingCalls.set(callId, {
          name,
          arguments: rawArguments,
          startTime: event.time,
        })
        break
      }
      // 这个是代码中最重要的部分。
      case 'tool/result': {
        const { turn, message, error } = event.data
        const block = message.content[0]
        const callId = block?.toolCallId
        if (!callId) break

        const acc = this.ensureTurn(turn)
        const pending = acc.pendingCalls.get(callId)
        const name = pending?.name ?? 'unknown'
        let parameters: Record<string, unknown> = {}
        if (pending?.arguments) {
          try {
            const parsed: unknown = JSON.parse(pending.arguments)
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              parameters = parsed as Record<string, unknown>
            }
          } catch { /* model produced unparsable arguments — keep empty */ }
        }

        const isError = block?.isError === true || error !== undefined
        const summary = summarizeContent(block?.content)
        // bash-style results carry failure markers inside the text; two forms
        // exist depending on how the model invoked the command:
        //   "[exit code: N]" (expanded) and
        //   "Command failed with exit code $?" (literal, N lost).
        const exitMatch = summary?.match(/\[exit code: (\d+)\]/)
        const unknownExit = summary?.includes('Command failed with exit code') === true
        const commandFailed = (exitMatch != null && exitMatch[1] !== '0') || unknownExit
        acc.pendingCalls.delete(callId)
        acc.completedCalls.push({
          callId,
          toolName: name,
          parameters,
          startedAt: pending?.startTime ?? event.time,
          endedAt: event.time,
          latencyMs: pending ? event.time - pending.startTime : 0,
          success: !isError && !commandFailed,
          resultSummary: isError || commandFailed ? null : summary,
          errorMessage: isError
            ? (error !== undefined ? `${error.name}: ${error.code}` : summary ?? 'unknown error')
            : commandFailed
              ? summary ?? `command exited with code ${exitMatch?.[1] ?? '?'}`
              : null,
        })
        break
      }
    }
  }

  /** Consume a completed turn. Returns null when the turn has no tool calls. */
  finalizeTurn(turn: number): TurnRecord | null {
    const acc = this.turns.get(turn)
    if (!acc || acc.completedCalls.length === 0) {
      this.turns.delete(turn)
      return null
    }
    this.turns.delete(turn)
    return {
      sessionId: this.sessionId,
      turn,
      goal: acc.goal || `dsh session ${this.sessionId} turn ${turn}`,
      plannerTrace: acc.plannerTrace,
      calls: acc.completedCalls,
    }
  }
  
  private ensureTurn(turn: number): TurnAccumulator {
    let acc = this.turns.get(turn)
    if (!acc) {
      acc = {
        turn,
        goal: '',
        plannerTrace: [],
        pendingCalls: new Map(),
        completedCalls: [],
      }
      this.turns.set(turn, acc)
    }
    return acc
  }
}

/** Map of session-id → tracker, bounded so abandoned sessions cannot grow unbounded. */
const MAX_TRACKED_SESSIONS = 64
const sessions = new Map<string, SessionTracker>()

export function trackerFor(session: Session): SessionTracker {
  const id = String(session.header.id)
  let tracker = sessions.get(id)
  if (!tracker) {
    tracker = new SessionTracker(
      id,
      session.header.cwd,
      session.header.agentPreset,
    )
    sessions.set(id, tracker)
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
  }
  return tracker
}

export function dropTracker(sessionId: string): void {
  sessions.delete(sessionId)
}

export function trackerCount(): number {
  return sessions.size
}

// ---- helpers ---------------------------------------------------------------

function extractText(content: unknown): string | null {
  if (!content) return null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text?: string } =>
          typeof block === 'object' && block !== null && (block as { type: string }).type === 'text',
      )
      .map(block => block.text ?? '')
      .join('')
  }
  return null
}

function summarizeContent(content: unknown): string | null {
  if (content == null) return null
  if (typeof content === 'string') return content.slice(0, 500)
  if (typeof content === 'number' || typeof content === 'boolean') return String(content)
  if (Array.isArray(content)) {
    const text = extractText(content)
    if (text) return text.slice(0, 500)
  }
  try {
    return JSON.stringify(content).slice(0, 500)
  } catch {
    return String(content).slice(0, 500)
  }
}
