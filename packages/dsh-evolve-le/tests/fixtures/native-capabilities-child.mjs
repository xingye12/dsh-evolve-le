import { Context } from '@deepseek-ai/cordis'
import { bootLoader } from './runner/cordis/boot.js'
import { snapshotCordisInventory } from './runner/cordis/inventory.js'
import { createNativeSolveAgent } from './runner/acp/native-solve-agent.js'
import { runNativeProposal } from './runner/dsh/native-proposal-runner.js'
import { readFile } from 'node:fs/promises'
import { installNativeLlmAdapter } from './runner/dsh/native-llm-adapter.js'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const ctx = new Context()
const before = snapshotCordisInventory(ctx)
const boot = await bootLoader(join(root, 'cordis.yml'), {
  context: ctx,
  bareModuleBaseUrl: pathToFileURL(join(root, 'node_modules/')).href,
})
const usage = { costUsdMicros: 0, inputTokens: 0, outputTokens: 0 }
let phase = 'delegate',
  rootCalls = 0,
  childCalls = 0,
  summaryCalls = 0
let eventCheckpointUsed = false
let childTools = false,
  childCandidate = false
let signalCancelled = false
let notifyChild
const childEntered = new Promise((resolve) => {
  notifyChild = resolve
})
const disposeAdapter = installNativeLlmAdapter(ctx, {
  provider: 'fixture',
  model: 'fixture',
  contextWindowTokens: 16000,
  maxTokens: 8192,
  usageSink: usage,
  complete(request) {
    const text = JSON.stringify(request.messages)
    eventCheckpointUsed ||= text.includes('EVENT_TOOL_RECOVERY')
    if (phase === 'request-failure' || (phase === 'callback-error' && rootCalls > 0))
      throw new Error('SECRET_PROVIDER_FAILURE')
    const isSummary = text.includes('acting as a compaction engine')
    const isChild = request.messages.some(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('CHILD TASK'),
    )
    let responseText = 'done',
      toolCalls
    if (phase === 'proposal') {
      if (isChild && childCalls++ === 0)
        toolCalls = [
          {
            id: 'proposal-read',
            name: 'proposal_read_file',
            arguments: JSON.stringify({ path: 'parent/src/index.ts' }),
          },
        ]
      else if (!isChild && rootCalls++ === 0)
        toolCalls = [
          {
            id: 'proposal-delegate',
            name: 'subagent',
            arguments: JSON.stringify({
              description: 'review',
              prompt: 'CHILD TASK: inspect the parent.',
            }),
          },
        ]
      else if (!isChild && rootCalls === 2)
        toolCalls = [
          {
            id: 'proposal-submit',
            name: 'proposal_finish',
            arguments: JSON.stringify({
              proposal: {
                schemaVersion: 1,
                protocol: 'dsh-evolve-le/proposal/v1',
                parentSourceHash: `sha256:${'a'.repeat(64)}`,
                children: [
                  {
                    childName: 'child-1',
                    hypothesis: 'A scoped strategy improvement.',
                    donorCandidates: [],
                    evidenceRefs: [],
                    targetFailureModes: ['planning'],
                  },
                ],
              },
            }),
          },
        ]
    } else if (isSummary) {
      summaryCalls++
      responseText = 'Checkpoint: inspect the workspace and finish the task.'
    } else if (isChild) {
      if (phase === 'cancel') {
        notifyChild()
        return new Promise((resolve, reject) => {
          const abort = () => {
            signalCancelled = true
            reject(new Error('cancelled child completion'))
          }
          if (request.signal.aborted) abort()
          else request.signal.addEventListener('abort', abort, { once: true })
        })
      }
      childTools =
        request.tools.some((t) => t.name === 'solve_read') &&
        !request.tools.some((t) => t.name === 'subagent')
      childCandidate = request.system.includes('CANDIDATE_SCOPE')
      if (phase === 'steps' || childCalls++ === 0)
        toolCalls = [
          {
            id: 'child-read',
            name: 'solve_read',
            arguments: JSON.stringify({ path: '/tmp/child.txt' }),
          },
        ]
    } else if ((phase === 'delegate' || phase === 'cancel') && rootCalls++ === 0) {
      toolCalls = [
        {
          id: 'delegate',
          name: 'subagent',
          arguments: JSON.stringify({
            description: 'inspect',
            prompt: 'CHILD TASK: inspect the file and answer.',
          }),
        },
      ]
    } else if (phase === 'concurrent' && rootCalls++ === 0) {
      toolCalls = [0, 1, 2].map((i) => ({
        id: `parallel-${i}`,
        name: 'subagent',
        arguments: JSON.stringify({
          description: 'inspect',
          prompt: 'CHILD TASK: inspect and report.',
        }),
      }))
    } else if (
      (phase === 'steps' && rootCalls++ === 0) ||
      (phase === 'limits' && rootCalls++ < 5)
    ) {
      toolCalls = [
        {
          id: `delegate-${rootCalls}`,
          name: 'subagent',
          arguments: JSON.stringify({
            description: 'inspect',
            prompt: 'CHILD TASK: inspect and report.',
          }),
        },
      ]
    } else if (phase === 'callback-error' && rootCalls++ === 0) {
      toolCalls = [
        {
          id: 'before-failure',
          name: 'solve_read',
          arguments: JSON.stringify({ path: '/tmp/child.txt' }),
        },
      ]
    } else if (phase === 'compress' && rootCalls++ < 3) {
      toolCalls = [
        {
          id: `read-${rootCalls}`,
          name: 'solve_read',
          arguments: JSON.stringify({ path: '/tmp/large.txt' }),
        },
      ]
    }
    const promptTokens = Math.ceil((text.length + (request.system?.length ?? 0)) / 4)
    usage.costUsdMicros += 100
    return {
      responseText: toolCalls ? '' : responseText,
      toolCalls,
      promptTokens,
      completionTokens: 20,
    }
  },
})
const updates = []
const connection = {
  async sessionUpdate(update) {
    updates.push(update)
  },
  async readTextFile() {
    return { content: phase === 'compress' ? 'large observation '.repeat(2500) : 'child evidence' }
  },
}
const agent = createNativeSolveAgent(ctx, connection, {
  provider: 'fixture',
  model: 'fixture',
  maxTokens: 8192,
  usageSink: usage,
})
const delegated = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
await agent.prompt({
  sessionId: delegated.sessionId,
  prompt: [{ type: 'text', text: 'Delegate an independent inspection.' }],
})
const children = agent.sessions.get(delegated.sessionId).subagents
phase = 'compress'
rootCalls = 0
const compressed = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
const reply = await agent.prompt({
  sessionId: compressed.sessionId,
  prompt: [{ type: 'text', text: 'Inspect several large observations and finish.' }],
})
const events = agent.sessions.get(compressed.sessionId).handle.agent.session.events
const aggregateUsage =
  reply.usage.inputTokens === usage.inputTokens && reply.usage.outputTokens === usage.outputTokens
const compactionEvents = events.filter((e) => e.type.startsWith('compaction/')).length
const metadata = updates.find((u) => u.update._meta)?.update._meta['dsh-evolve-le/native-evidence']
const evidenceExported = metadata.subagents.length === 1 && metadata.events.length > 0
phase = 'limits'
rootCalls = 0
childCalls = 0
const limited = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
await agent.prompt({
  sessionId: limited.sessionId,
  prompt: [{ type: 'text', text: 'Try five independent delegations.' }],
})
const limitedSession = agent.sessions.get(limited.sessionId)
const countLimited =
  limitedSession.subagents.length === 4 &&
  JSON.stringify(limitedSession.handle.agent.session.events).includes('count limit exceeded')
phase = 'concurrent'
rootCalls = 0
childCalls = 0
const concurrent = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
await agent.prompt({
  sessionId: concurrent.sessionId,
  prompt: [{ type: 'text', text: 'Try three simultaneous delegations.' }],
})
const concurrentSession = agent.sessions.get(concurrent.sessionId)
const concurrencyLimited =
  concurrentSession.subagents.length === 2 &&
  JSON.stringify(concurrentSession.handle.agent.session.events).includes(
    'concurrent limit exceeded',
  )
phase = 'steps'
rootCalls = 0
childCalls = 0
const stepped = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
await agent.prompt({
  sessionId: stepped.sessionId,
  prompt: [{ type: 'text', text: 'Delegate a bounded worker.' }],
})
const stepLimited = agent.sessions.get(stepped.sessionId).subagents[0].stopReason === 'refusal'
phase = 'cancel'
rootCalls = 0
childCalls = 0
const cancelled = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
const pending = agent.prompt({
  sessionId: cancelled.sessionId,
  prompt: [{ type: 'text', text: 'Delegate and await cancellation.' }],
})
await childEntered
await agent.cancel({ sessionId: cancelled.sessionId })
const cancelReply = await pending
const cancelEvidence = agent.sessions.get(cancelled.sessionId).subagents
const cancellationPassed =
  signalCancelled &&
  cancelReply.stopReason === 'cancelled' &&
  cancelEvidence[0].stopReason === 'aborted'
phase = 'request-failure'
const failed = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
await agent.prompt({
  sessionId: failed.sessionId,
  prompt: [{ type: 'text', text: 'Exercise model request failure.' }],
})
phase = 'callback-error'
rootCalls = 0
const callbackError = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
let callbackRejected = false
try {
  await agent.prompt({
    sessionId: callbackError.sessionId,
    prompt: [{ type: 'text', text: 'Exercise callback failure.' }],
  })
} catch (error) {
  callbackRejected = String(error).includes('candidate callback failed')
}
const failedEventAuditExported =
  callbackRejected &&
  updates.some(
    (u) =>
      u.sessionId === callbackError.sessionId &&
      u.update._meta?.['dsh-evolve-le/native-evidence']?.candidateEvents.some(
        (e) => e.ok === false && e.name === 'candidate:agent/request-error',
      ),
  )
const eventRecords = [...agent.sessions.values()].flatMap((s) => s.candidateEvents())
const expandedNames = [...new Set(eventRecords.map((e) => e.name))]
const expectedExpanded = [
  'candidate:agent/request',
  'candidate:agent/request-error',
  'candidate:agent/error',
  'candidate:agent/status',
  'candidate:agent/turn-stopping',
  'candidate:agent/tool-pre-execute',
  'candidate:agent/tool-post-execute',
  'candidate:agent/tool-result',
  'candidate:session/event',
  'candidate:session/turn-start',
  'candidate:session/turn-end',
  'candidate:session/step-start',
  'candidate:session/step-end',
  'candidate:session/compaction-start',
  'candidate:session/compaction-summary',
  'candidate:session/compaction-end',
]
const expandedEventsPassed = expectedExpanded.every((n) => expandedNames.includes(n))
const childEventsPassed = children[0].candidateEvents.some(
  (e) => e.name === 'candidate:agent/tool-result',
)
const eventFactsSafe =
  !JSON.stringify(eventRecords).includes('SECRET_PROVIDER_FAILURE') &&
  eventRecords
    .filter((e) => e.context.phase === 'event')
    .every((e) => e.context.protocol === 'dsh-evolve-le/candidate-strategy-context/v2')
await agent.dispose()
phase = 'proposal'
rootCalls = 0
childCalls = 0
let proposalReads = 0
const proposalPath = join(root, 'proposal.json')
const proposal = await runNativeProposal({
  ctx,
  sessionId: 'proposal-fixture',
  cwd: '/tmp',
  provider: 'fixture',
  model: 'fixture',
  maxTokens: 8192,
  maxTurns: 10,
  prompt: 'Review the parent then submit the proposal.',
  proposalPath,
  backend: {
    async listInput() {
      return []
    },
    async readInput() {
      proposalReads++
      return 'parent source'
    },
    async writeChildFile() {},
    async finalizeProposal(p) {
      return p
    },
  },
})
const transcript = JSON.parse(await readFile(proposal.transcriptPath, 'utf8'))
const proposalPassed =
  proposalReads === 1 &&
  transcript.subagents.length === 1 &&
  transcript.subagents[0].stopReason === 'completed' &&
  transcript.subagents[0].events.length > 5
const proposalEventsPassed =
  transcript.candidateEvents.some((e) => e.name === 'candidate:agent/tool-result') &&
  transcript.subagents[0].candidateEvents.some((e) => e.name === 'candidate:session/turn-end')
const liveAgentsAfterDispose = ctx.agents.list().length
disposeAdapter()
await boot.loaderFiber.dispose()
const after = snapshotCordisInventory(ctx)
console.log(
  JSON.stringify({
    children: children.length,
    childTools,
    childCandidate,
    childStop: children[0]?.stopReason,
    childEvents: children[0]?.events.length,
    summaryCalls,
    compactionEvents,
    aggregateUsage,
    evidenceExported,
    countLimited,
    concurrencyLimited,
    stepLimited,
    cancellationPassed,
    proposalPassed,
    expandedEventsPassed,
    childEventsPassed,
    proposalEventsPassed,
    eventCheckpointUsed,
    eventFactsSafe,
    failedEventAuditExported,
    expandedNames,
    liveAgentsAfterDispose,
    quiescent: JSON.stringify(before) === JSON.stringify(after),
  }),
)
await ctx.fiber.dispose()
