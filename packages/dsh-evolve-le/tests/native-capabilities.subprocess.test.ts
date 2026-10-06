import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { bootConfig } from '../src/builder/capsule.js'
import { CANDIDATE_RUNTIME_EVENT_NAMES } from '../src/dsh/candidate-events.js'

const exec = promisify(execFile)
const closure = process.env.DSH_NATIVE_CLOSURE_ROOT ?? '/tmp/dsh-native-capabilities-closure'
const native = existsSync(
  join(closure, 'node_modules/@deepseek-ai/dsh-compaction-basic/package.json'),
)

describe.skipIf(!native)('native capabilities through real production Loader', () => {
  it('compresses, delegates with ACP tools, records child evidence and aggregate usage, and unloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-capabilities-e2e-'))
    try {
      await symlink(join(closure, 'node_modules'), join(root, 'node_modules'))
      await cp(resolve('packages/dsh-evolve-le/lib'), join(root, 'runner'), { recursive: true })
      await mkdir(join(root, 'runtime'))
      await cp(
        resolve('packages/dsh-evolve-le/lib/probe/candidate-workflow-stub.js'),
        join(root, 'runtime/candidate-workflow-stub.mjs'),
      )
      await writeFile(
        join(root, 'candidate.mjs'),
        `import {defineCandidate} from '@dsh-evolve-le/candidate-sdk';
const names=${JSON.stringify(CANDIDATE_RUNTIME_EVENT_NAMES)};
const behavior={promptSection:()=>({name:'candidate:fixture',order:10,text:'CANDIDATE_SCOPE'}),agentEvents:()=>names.filter(n=>n.startsWith('candidate:agent/')).map(name=>({name,handler:c=> {if(name==='candidate:agent/request-error'&&c.observation.toolCalls.read>0) throw Error('candidate callback failed');return name==='candidate:agent/tool-result'?{checkpoint:'EVENT_TOOL_RECOVERY'}:undefined}})),sessionEvents:()=>names.filter(n=>n.startsWith('candidate:session/')).map(name=>({name,handler:()=>undefined}))};
const candidate=defineCandidate({solve:behavior,propose:behavior});
export const name='fixture';export function apply(ctx){ctx.provide('candidateStrategySetup',agent=>candidate.register(agent,{candidateId:'fixture',mode:'solve'}));}`,
      )
      await writeFile(
        join(root, 'cordis.yml'),
        bootConfig('./candidate.mjs', 'fixture', 'solve', { dshHome: join(root, 'home') }),
      )
      await cp(
        resolve('packages/dsh-evolve-le/tests/fixtures/native-capabilities-child.mjs'),
        join(root, 'check.mjs'),
      )
      const { stdout } = await exec(process.execPath, [join(root, 'check.mjs')], {
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
      })
      const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
      expect(result.children).toBe(1)
      expect(result.childTools).toBe(true)
      expect(result.childCandidate).toBe(true)
      expect(result.childStop).toBe('completed')
      expect(result.childEvents).toBeGreaterThan(5)
      expect(result.summaryCalls).toBeGreaterThan(0)
      expect(result.compactionEvents).toBeGreaterThan(0)
      expect(result.aggregateUsage).toBe(true)
      expect(result.evidenceExported).toBe(true)
      expect(result.cancellationPassed).toBe(true)
      expect(result.countLimited).toBe(true)
      expect(result.stepLimited).toBe(true)
      expect(result.concurrencyLimited).toBe(true)
      expect(result.proposalPassed).toBe(true)
      expect(result.expandedEventsPassed).toBe(true)
      expect(result.childEventsPassed).toBe(true)
      expect(result.proposalEventsPassed).toBe(true)
      expect(result.eventCheckpointUsed).toBe(true)
      expect(result.eventFactsSafe).toBe(true)
      expect(result.failedEventAuditExported).toBe(true)
      expect(result.liveAgentsAfterDispose).toBe(0)
      expect(result.quiescent).toBe(true)
      if (process.env.DSH_NATIVE_VERIFICATION_PATH)
        await writeFile(
          process.env.DSH_NATIVE_VERIFICATION_PATH,
          JSON.stringify(result, null, 2) + '\n',
          { flag: 'wx' },
        )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 90000)
})
