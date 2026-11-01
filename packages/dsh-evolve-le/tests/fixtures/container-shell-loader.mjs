import { Context } from '@deepseek-ai/cordis'
import { bootLoader } from './runner/cordis/boot.js'
import { snapshotCordisInventory } from './runner/cordis/inventory.js'
import { installNativeLlmAdapter } from './runner/dsh/native-llm-adapter.js'
import { runNativeProposal } from './runner/dsh/native-proposal-runner.js'
const ctx = new Context()
const before = snapshotCordisInventory(ctx)
const boot = await bootLoader(new URL('./cordis.yml', import.meta.url).pathname, {
  context: ctx,
  bareModuleBaseUrl: new URL('./node_modules/', import.meta.url).href,
})
const tool = ctx.tools.get('bash')
if (!tool) throw Error('bash not discovered')
const signal = new AbortController().signal
const exec = { signal, callId: '1' }
const r = await tool.execute({ command: 'echo shared', description: 'test' }, exec)
if (r.stdout.text !== 'shared\n') throw Error('wrong result')
for (const extra of [
  { run_in_background: true },
  { sandbox_permissions: 'require_escalated', justification: 'try' },
]) {
  let denied = false
  try {
    await tool.execute({ command: 'echo shared', description: 'test', ...extra }, exec)
  } catch {
    denied = true
  }
  if (!denied) throw Error('expansion accepted')
}
const proposal = {
  schemaVersion: 1,
  protocol: 'dsh-evolve-le/proposal/v1',
  parentSourceHash: 'sha256:' + 'a'.repeat(64),
  children: [
    {
      childName: 'child-1',
      hypothesis: 'general planning',
      donorCandidates: [],
      evidenceRefs: [],
      targetFailureModes: ['planning'],
    },
  ],
}
let calls = 0
const disposeModel = installNativeLlmAdapter(ctx, {
  provider: 'fixture',
  model: 'fixture',
  contextWindowTokens: 32000,
  maxTokens: 1024,
  complete(request) {
    if (!request.tools.some((t) => t.name === 'bash')) throw Error('native bash not discovered')
    const index = calls++
    return {
      responseText: '',
      ...(index === 0
        ? {
            toolCalls: [
              {
                id: 'native-shell',
                name: 'bash',
                arguments: JSON.stringify({ command: 'echo shared', description: 'native model' }),
              },
            ],
          }
        : index === 1
          ? {
              toolCalls: [
                { id: 'finish', name: 'proposal_finish', arguments: JSON.stringify({ proposal }) },
              ],
            }
          : { responseText: 'done' }),
      promptTokens: 1,
      completionTokens: 1,
    }
  },
})
const native = await runNativeProposal({
  ctx,
  stopOnSubmission: true,
  backend: {
    async listInput() {
      return []
    },
    async readInput() {
      return ''
    },
    async writeChildFile() {},
    async finalizeProposal(p) {
      return p
    },
  },
  sessionId: 'execution-main',
  cwd: '/workspace',
  prompt: 'Use bash then submit.',
  proposalPath: new URL('./proposal.json', import.meta.url).pathname,
  provider: 'fixture',
  model: 'fixture',
  maxTurns: 4,
})
if (!native.proposal) throw Error('native proposal missing')
if (calls !== 2) throw Error('model dispatched after successful submission')
disposeModel()
await boot.loaderFiber.dispose()
for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
const after = snapshotCordisInventory(ctx)
if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('inventory drift')
console.log(
  JSON.stringify({
    bash: true,
    foreground: true,
    backgroundDenied: true,
    escalationDenied: true,
    nativeAgentLoop: true,
    quiescent: true,
  }),
)
