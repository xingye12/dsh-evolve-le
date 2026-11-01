import { parseGenerationDraft } from '../proposer/generation-draft.js'
import { validateRef } from '../state/object-store.js'
/** Worker-side capabilities: transport only; never runs a host command or test. */
import { randomUUID } from 'node:crypto'
import type { NativeProposalToolBackend } from '../dsh/native-proposal.js'
import type {
  NativeLlmCompletionRequest,
  NativeLlmCompletionResult,
} from '../dsh/native-llm-adapter.js'
import { parseProposalOutput } from '../proposer/protocol.js'
import { callActionRpc, type ActionRpcRequest } from './rpc.js'
import { assertExact, ExecutionError } from './types.js'
export function dockerProposalClient(options: {
  socketPath: string
  executionId: string
  timeoutMs: number
  maxFrameBytes: number
  generationOnly?: true
}) {
  const call = (method: ActionRpcRequest['method'], args: unknown, signal?: AbortSignal) =>
    callActionRpc({
      ...options,
      invocationId: `${method}-${randomUUID()}`,
      method,
      args,
      ...(signal === undefined ? {} : { signal }),
    })
  const backend: NativeProposalToolBackend = {
    async listInput(path) {
      const value = await call('list-input', { path })
      assertExact(value, ['files'])
      if (!Array.isArray(value.files) || value.files.some((p) => typeof p !== 'string'))
        throw new ExecutionError('invalid external directory reply')
      return value.files as string[]
    },
    async readInput(path) {
      const value = await call('read-input', { path })
      assertExact(value, ['content'])
      if (typeof value.content !== 'string') throw new ExecutionError('invalid external file reply')
      return value.content
    },
    async writeChildFile(childName, path, content) {
      await call('write-child', { child: childName, path, content })
    },
    async testChild(childName) {
      const value = await call('test-child', { child: childName })
      assertExact(value, ['ok', 'output', 'receipt', 'source'])
      if (typeof value.ok !== 'boolean' || typeof value.output !== 'string')
        throw new ExecutionError('invalid snapshot test response')
      validateRef(value.receipt)
      validateRef(value.source)
      return JSON.stringify(value)
    },
    async finalizeProposal(proposal) {
      const value = await call('finish', { proposal })
      assertExact(value, ['proposal', 'receipt', 'sources'])
      if (options.generationOnly) parseGenerationDraft(value.proposal)
      else parseProposalOutput(value.proposal)
      return value.proposal
    },
  }
  if (options.generationOnly) {
    delete backend.testChild
    backend.generationOnly = true
  }
  return {
    backend,
    async mutationCount(): Promise<number> {
      const value = await call('mutation-count', {})
      assertExact(value, ['count'])
      if (typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0)
        throw new ExecutionError('invalid external mutation count')
      return value.count
    },
    async complete(request: NativeLlmCompletionRequest): Promise<NativeLlmCompletionResult> {
      const { signal, ...payload } = request
      const value = await call('model', { payload: JSON.stringify(payload) }, signal)
      if (
        value === null ||
        typeof value !== 'object' ||
        typeof (value as { responseText?: unknown }).responseText !== 'string'
      )
        throw new ExecutionError('invalid external model response')
      return value as NativeLlmCompletionResult
    },
  }
}
