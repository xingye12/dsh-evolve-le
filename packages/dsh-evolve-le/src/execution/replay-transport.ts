/** Frozen zero-fee transport for engineering acceptance; never a live-provider fallback. */
import { join } from 'node:path'
import { sha256Hex } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import type { NativeLlmCompletionResult } from '../dsh/native-llm-adapter.js'
import type { ProposalSupervisorOptions } from './supervisor.js'
import { readCanonicalFile } from './evidence.js'
import { assertExact, ExecutionError } from './types.js'
export async function frozenReplayDispatch(options: {
  store: ObjectStore
  root: string
  executionId: string
  route: ObjectRef
  model: Pick<ProposalSupervisorOptions['model'], 'provider' | 'model' | 'limits'>
}): Promise<ProposalSupervisorOptions['model']['dispatch']> {
  options = {
    ...options,
    route: structuredClone(options.route),
    model: structuredClone(options.model),
  }
  validateRef(options.route)
  if (
    options.route.label !== 'CONTROLLER_INTERNAL' ||
    options.route.size > options.model.limits.maxRequestBytes
  )
    throw new ExecutionError('invalid frozen replay route envelope')
  const raw: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await options.store.read(options.route)),
  )
  assertExact(raw, ['protocol', 'provider', 'model', 'responses'])
  if (
    raw.protocol !== 'dsh-evolve-le/model-replay/v1' ||
    raw.provider !== options.model.provider ||
    raw.model !== options.model.model ||
    !Array.isArray(raw.responses) ||
    !raw.responses.length ||
    raw.responses.length > options.model.limits.maxRequests ||
    options.model.limits.inputUsdMicrosPerMillion !== 0 ||
    options.model.limits.outputUsdMicrosPerMillion !== 0
  )
    throw new ExecutionError(
      'unsupported model transport or nonzero replay pricing; live provider is not enabled',
    )
  const responses: NativeLlmCompletionResult[] = []
  for (const response of raw.responses) {
    assertExact(response, ['responseText', 'promptTokens', 'completionTokens'], ['toolCalls'])
    if (
      typeof response.responseText !== 'string' ||
      !Number.isSafeInteger(response.promptTokens) ||
      Number(response.promptTokens) < 0 ||
      Number(response.promptTokens) > options.model.limits.maxInputTokens ||
      !Number.isSafeInteger(response.completionTokens) ||
      Number(response.completionTokens) < 0 ||
      Number(response.completionTokens) > options.model.limits.maxOutputTokens
    )
      throw new ExecutionError('invalid replay response/usage')
    if (response.toolCalls !== undefined) {
      if (!Array.isArray(response.toolCalls)) throw new ExecutionError('invalid replay tool calls')
      for (const tool of response.toolCalls) {
        assertExact(tool, ['id', 'name', 'arguments'])
        if (
          [tool.id, tool.name, tool.arguments].some((value) => typeof value !== 'string' || !value)
        )
          throw new ExecutionError('invalid replay tool call')
      }
    }
    responses.push(response as unknown as NativeLlmCompletionResult)
  }
  return async (requestId, request, signal) => {
    if (signal.aborted || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(requestId))
      throw new ExecutionError('replay dispatch aborted/invalid id')
    const intent = await readCanonicalFile(join(options.root, requestId, 'intent.json'))
    assertExact(intent, [
      'executionId',
      'requestId',
      'request',
      'requestDigest',
      'sequence',
      'reservedTokens',
      'reservedUsdMicros',
    ])
    validateRef(intent.request)
    if (
      intent.executionId !== options.executionId ||
      intent.requestId !== requestId ||
      intent.requestDigest !== sha256Hex(JSON.stringify(request)) ||
      intent.request.digest !== intent.requestDigest ||
      !Number.isSafeInteger(intent.sequence) ||
      Number(intent.sequence) < 1 ||
      Number(intent.sequence) > responses.length ||
      request.provider !== options.model.provider ||
      request.model !== options.model.model
    )
      throw new ExecutionError('replay dispatch lacks durable matching model intent')
    await options.store.verify(intent.request)
    return structuredClone(responses[Number(intent.sequence) - 1]!)
  }
}
