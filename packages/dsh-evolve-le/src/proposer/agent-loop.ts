/**
 * Proposer agent loop (Gate 4, specs/07 §6): drives the deterministic policy
 * behind the model gateway turn by turn — composed system sections (TCB
 * policy + the parent candidate's propose contribution), one user channel
 * carrying the instruction and rendered tool results, directives executed
 * ONLY through the tool layer, and an append-only JSONL transcript recording
 * every prompt hash, response, tool call, refusal, token count, cost and
 * source reference. The transcript is the integrity artifact: replaying the
 * same policy over the same inputs must reproduce it byte for byte.
 * @module @dsh-evolve-le/core/proposer/agent-loop
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { ModelGateway, GatewayUsage } from './gateway.js'
import { promptSha256 } from '../acp/recorded-replay.js'
import { parseDirective, type PolicyAction, type PolicyDirective } from './policy.js'
import { parseProposalOutput, type ProposalOutput } from './protocol.js'
import type { ProposerTools } from './tools.js'

export const AGENT_LOOP_VERSION = 'dsh-evolve-le/proposer-agent-loop/v1'
export const DEFAULT_MAX_TURNS = 24

export class AgentLoopError extends Error {
  constructor(message: string) {
    super(`agent-loop: ${message}`)
    this.name = 'AgentLoopError'
  }
}

export type TranscriptRecord =
  | {
      kind: 'turn'
      seq: number
      requestId: string
      promptSha256: string
      sections: string[]
      userDigest: string
      responseText: string
      promptTokens: number
      completionTokens: number
      costUsdMicros: number
    }
  | {
      kind: 'tool'
      seq: number
      action: PolicyAction
      ok: boolean
      result: string
      sourceRef?: { path: string; sha256?: string }
    }
  | { kind: 'proposal'; seq: number; proposal: ProposalOutput }
  | {
      /** A response that did not parse as a directive (recoverable). */
      kind: 'protocol'
      seq: number
      error: string
    }
  | { kind: 'summary'; seq: number; usage: GatewayUsage; turns: number; outcome: 'submitted' }

export interface AgentLoopResult {
  proposal: ProposalOutput
  usage: GatewayUsage
  turns: number
  transcriptPath: string
}

/** Render one executed action into the line-oriented tool-results block. */
async function executeAction(
  action: PolicyAction,
  tools: ProposerTools,
): Promise<{ lines: string[]; sourceRef?: { path: string; sha256?: string }; ok: boolean }> {
  if (action.op === 'list') {
    try {
      const names = await tools.listInput(action.path)
      return {
        ok: true,
        lines: [`list ${action.path}`, ...names, ''],
        sourceRef: { path: action.path },
      }
    } catch (error) {
      return { ok: false, lines: [renderError('list', action.path, error)] }
    }
  }
  if (action.op === 'read') {
    try {
      const content = await tools.readInput(action.path)
      const sha = createHash('sha256').update(content, 'utf8').digest('hex')
      return {
        ok: true,
        lines: [`read ${action.path} (sha256:${sha}) ${JSON.stringify(content)}`],
        sourceRef: { path: action.path, sha256: sha },
      }
    } catch (error) {
      return { ok: false, lines: [renderError('read', action.path, error)] }
    }
  }
  if (action.op === 'writeChild') {
    const lines: string[] = []
    let ok = true
    for (const [relPath, content] of Object.entries(action.files)) {
      try {
        await tools.writeChildFile(action.childName, relPath, content)
        lines.push(`writeChild ${action.childName}/${relPath} OK`)
      } catch (error) {
        ok = false
        lines.push(renderError('writeChild', `${action.childName}/${relPath}`, error))
      }
    }
    return { ok, lines }
  }
  return { ok: false, lines: [renderError(action.op, '', new Error('unknown action'))] }
}

function renderError(op: string, path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `error ${op} ${path} ${message.replaceAll('\n', ' ')}`
}

/**
 * Run the proposer loop to a submitted proposal (or fail after maxTurns).
 * Every turn appends transcript records; the final proposal is validated with
 * the protocol parser and written next to the transcript.
 */
export async function runProposerAgentLoop(options: {
  gateway: ModelGateway
  tools: ProposerTools
  sections: readonly { name: string; order: number; text: string }[]
  instruction: string
  transcriptPath: string
  proposalPath: string
  maxTurns?: number
}): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  await mkdir(dirname(options.transcriptPath), { recursive: true })
  let seq = 0
  const records: TranscriptRecord[] = []
  const append = async (record: TranscriptRecord): Promise<void> => {
    seq += 1
    const withSeq = { ...record, seq } as TranscriptRecord
    records.push(withSeq)
    await appendFile(options.transcriptPath, `${JSON.stringify(withSeq)}\n`, 'utf8')
  }

  let userText = options.instruction
  let proposal: ProposalOutput | undefined
  let turns = 0

  while (proposal === undefined) {
    turns += 1
    if (turns > maxTurns) {
      throw new AgentLoopError(`no proposal submitted within ${maxTurns} turns`)
    }
    const promptSha = promptSha256({ sections: options.sections, userText })
    const before = options.gateway.usage()
    const responseText = await options.gateway.complete({
      sections: options.sections,
      userText,
    })
    const usage = options.gateway.usage()
    await append({
      kind: 'turn',
      seq: 0,
      requestId: `req-${usage.requests}`,
      promptSha256: promptSha,
      sections: [...options.sections]
        .sort((a, b) => a.order - b.order)
        .map((section) => section.name),
      userDigest: createHash('sha256').update(userText, 'utf8').digest('hex'),
      responseText,
      promptTokens: usage.promptTokens - before.promptTokens,
      completionTokens: usage.completionTokens - before.completionTokens,
      costUsdMicros: usage.costUsdMicros - before.costUsdMicros,
    })

    let directive: PolicyDirective
    try {
      directive = parseDirective(responseText)
    } catch (error) {
      // A real model can hand-roll unbalanced JSON (observed live in Gate 8).
      // The turn is spent and billed; the failure renders back like a tool
      // error and the model resends, bounded by the same maxTurns budget.
      const message = `error directive ${
        error instanceof Error ? error.message.replaceAll('\n', ' ') : String(error)
      } — your last response was not a parseable directive; resend ONE complete directive`
      await append({ kind: 'protocol', seq: 0, error: message })
      userText = `${userText}\n\n[tool results]\n${message}\n`
      continue
    }
    const blockLines: string[] = []
    for (const action of directive.actions) {
      if (action.op === 'submit') {
        parseProposalOutput(action.proposal)
        proposal = action.proposal
        await append({ kind: 'proposal', seq: 0, proposal: action.proposal })
        blockLines.push('submit OK')
        break
      }
      const executed = await executeAction(action, options.tools)
      blockLines.push(...executed.lines)
      await append({
        kind: 'tool',
        seq: 0,
        action,
        ok: executed.ok,
        result: executed.lines.join('\n'),
        ...(executed.sourceRef !== undefined ? { sourceRef: executed.sourceRef } : {}),
      })
    }
    if (proposal !== undefined) break
    userText = `${userText}\n\n[tool results]\n${blockLines.join('\n')}\n`
  }

  const usage = options.gateway.usage()
  await append({ kind: 'summary', seq: 0, usage, turns, outcome: 'submitted' })
  await writeFile(options.proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8')
  return { proposal, usage, turns, transcriptPath: options.transcriptPath }
}
