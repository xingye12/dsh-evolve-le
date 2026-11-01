/** Credential-bearing transport is external to the container and always dispatches once. */
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { ObjectStore } from '../state/object-store.js'
import type { RemoteRoutePlan } from '../proposer/remote-gateway.js'
import { upstreamChatCompletion } from '../proposer/upstream.js'
import type { ProposalGenerationConfig } from './proposal-generation-config.js'
import type { ProposalGenerationOptions } from './proposal-generation.js'
import { assertExact, ExecutionError } from './types.js'
export async function openGenerationLiveDispatch(
  config: Pick<ProposalGenerationConfig, 'model' | 'spec'>,
  store: ObjectStore,
  credentialFile: string,
): Promise<ProposalGenerationOptions['model']['dispatch']> {
  config = structuredClone(config)
  if (config.model.route.label !== 'CONTROLLER_INTERNAL' || config.model.route.size > 65536)
    throw new ExecutionError('invalid live route envelope')
  const raw = JSON.parse((await store.read(config.model.route)).toString('utf8')) as unknown
  assertExact(raw, [
    'routeId',
    'baseUrl',
    'model',
    'temperature',
    'maxOutputTokens',
    'inputUsdPerMTok',
    'outputUsdPerMTok',
    'retry',
  ])
  assertExact(raw.retry, ['maxAttempts', 'backoffMs'])
  if (
    raw.model !== config.model.model ||
    raw.maxOutputTokens !== config.model.limits.maxOutputTokens ||
    raw.retry.maxAttempts !== 1 ||
    !Array.isArray(raw.retry.backoffMs) ||
    raw.retry.backoffMs.length ||
    typeof raw.baseUrl !== 'string' ||
    new URL(raw.baseUrl).protocol !== 'https:' ||
    typeof raw.routeId !== 'string' ||
    typeof raw.temperature !== 'number' ||
    !Number.isFinite(raw.temperature) ||
    typeof raw.inputUsdPerMTok !== 'number' ||
    typeof raw.outputUsdPerMTok !== 'number' ||
    Math.round(raw.inputUsdPerMTok * 1e6) !== config.model.limits.inputUsdMicrosPerMillion ||
    Math.round(raw.outputUsdPerMTok * 1e6) !== config.model.limits.outputUsdMicrosPerMillion
  )
    throw new ExecutionError('live route differs from frozen limits or permits retries')
  const plan = raw as unknown as RemoteRoutePlan
  if (!credentialFile.startsWith('/')) throw new ExecutionError('credential file must be absolute')
  const handle = await open(
    credentialFile,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let credential: string
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      stat.size > 16384
    )
      throw new ExecutionError('credential file must be private, bounded and root-owned')
    credential = (await handle.readFile('utf8')).trim()
    if (!credential || /[\r\n]/.test(credential)) throw new ExecutionError('invalid credential')
  } finally {
    await handle.close()
  }
  return async (_id, request, signal) => {
    const remaining = Date.parse(config.spec.deadlineUtc) - Date.now()
    // UTF-8 envelope bytes plus framing allowance conservatively bound the visible prompt.
    if (
      Buffer.byteLength(JSON.stringify(request), 'utf8') + 4096 >
      config.model.limits.maxInputTokens
    )
      throw new ExecutionError('live input exceeds reserved token bound before dispatch')
    if (
      signal.aborted ||
      remaining <= 0 ||
      request.provider !== config.model.provider ||
      request.model !== config.model.model
    )
      throw new ExecutionError('live request expired or route mismatch')
    try {
      const result = await upstreamChatCompletion({
        plan,
        credential,
        sections: request.system ? [{ name: 'native-system', order: 0, text: request.system }] : [],
        userText: request.userText ?? '',
        messages: [
          ...(request.system ? [{ role: 'system', content: request.system }] : []),
          ...request.messages,
        ],
        tools: request.tools,
        signal,
        requestTimeoutMs: Math.min(600000, remaining),
        retryTotalBudgetMs: remaining,
      })
      if (!result.ok || !result.modelReportedUsage)
        throw new ExecutionError('unaccountable live response')
      return {
        responseText: result.content,
        toolCalls: result.toolCalls,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      }
    } catch {
      throw new ExecutionError('live dispatch failed; reservation remains ambiguous')
    }
  }
}
