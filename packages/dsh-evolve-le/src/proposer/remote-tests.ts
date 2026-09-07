/**
 * Candidate-test socket client for the proposal sandbox worker (ADR-038):
 * the worker asks the controller-side gateway proxy to run the stage-6
 * typeLintUnit suite over one child's merged parent+child view. Same pattern
 * as `remote-model.ts` — one connection per request, one line in, one line
 * out — and just as dependency-light so it ships in the worker runtime tree.
 *
 * The gateway verifies the merged view's parent bytes against its staged
 * parent view before running anything; this side only reports what comes
 * back. Transport and protocol failures throw, and the caller
 * (`proposer/tools.ts`) surfaces them as the proposal_finish tool error they
 * are — the model can retry, and a dead channel fails the finalization the
 * way any failed TCB dependency does.
 * @module @dsh-evolve-le/core/proposer/remote-tests
 */

import { createConnection } from 'node:net'

/**
 * Worst case of one test run: oxlint (60s) then vitest (180s), plus margin —
 * the builder's own stage-6 timeouts. The worker-side socket client must
 * outlast the proxy's run or it would race the reply.
 */
export const DEFAULT_CANDIDATE_TEST_TIMEOUT_MS = 300_000

export interface CandidateTestReply {
  ok: boolean
  output: string
}

export function sendCandidateTests(options: {
  socketPath: string
  childName: string
  files: Record<string, string>
  timeoutMs?: number
}): Promise<CandidateTestReply> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CANDIDATE_TEST_TIMEOUT_MS
  return new Promise<CandidateTestReply>((resolve, reject) => {
    const socket = createConnection(options.socketPath)
    let buffer = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      socket.destroy()
      fn()
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({
          v: 1,
          type: 'candidate-tests',
          childName: options.childName,
          files: options.files,
        })}\n`,
      ),
    )
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      finish(() => {
        try {
          const reply = JSON.parse(line) as { type?: string; ok?: boolean; output?: string }
          if (reply.type !== 'result' || typeof reply.ok !== 'boolean') {
            reject(new Error('gateway replied with an unexpected shape'))
            return
          }
          resolve({ ok: reply.ok, output: reply.output ?? '' })
        } catch (error) {
          reject(new Error(`unparseable gateway reply: ${(error as Error).message}`))
        }
      })
    })
    socket.on('timeout', () =>
      finish(() =>
        reject(new Error(`candidate-test socket timed out after ${String(timeoutMs)}ms`)),
      ),
    )
    socket.on('error', (error) => finish(() => reject(error)))
    socket.on('close', () =>
      finish(() => reject(new Error('candidate-test socket closed before a reply'))),
    )
  })
}
