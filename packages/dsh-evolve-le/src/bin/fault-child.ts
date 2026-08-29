/**
 * Crash-harness child (Gate 3, specs/06 §16 + specs/07 §5): a real controller
 * process driven through a complete run — phases, a wave of three evaluation
 * actions, wave commit — against the file-backed provider, with an optional
 * hard-kill at the first occurrence of a named saga boundary.
 *
 * The kill is `process.kill(pid, SIGKILL)`: no exit handlers, no flush, no
 * lock release — the closest thing to a power cut the platform offers. The
 * parent process then resumes with another instance of this bin and asserts
 * from outside (journal + provider file) that no external effect, score, or
 * cost was duplicated.
 *
 * Usage:
 *   node lib/bin/fault-child.js <runDir> <objectsRoot> <providerFile> \
 *     [--crash-at <boundary>] [--outcome <key=outcome>] [--report <file>]
 *
 * On a clean run it writes a JSON report (state hash, status, recovery info)
 * to stdout.
 */
import { Controller, readRunStatus, type BoundaryPoint } from '../controller/controller.js'
import { FileProvider } from '../controller/file-provider.js'

interface Args {
  runDir: string
  objectsRoot: string
  providerFile: string
  crashAt?: BoundaryPoint
  outcomes: Array<[string, 'success' | 'failure' | 'timeout' | 'missing']>
}

function parseArgs(argv: string[]): Args {
  const [runDir, objectsRoot, providerFile, ...rest] = argv
  if (runDir === undefined || objectsRoot === undefined || providerFile === undefined) {
    throw new Error(
      'usage: fault-child <runDir> <objectsRoot> <providerFile> [--crash-at <boundary>] [--outcome key=val]',
    )
  }
  const args: Args = { runDir, objectsRoot, providerFile, outcomes: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (flag === '--crash-at') {
      args.crashAt = rest[index + 1] as BoundaryPoint
      index += 1
    } else if (flag === '--outcome') {
      const pair = rest[index + 1] ?? ''
      const [key, outcome] = pair.split('=')
      if (key === undefined || outcome === undefined) throw new Error(`bad --outcome ${pair}`)
      args.outcomes.push([key, outcome as Args['outcomes'][number][1]])
      index += 1
    } else {
      throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const provider = await FileProvider.open(args.providerFile)
for (const [key, outcome] of args.outcomes) {
  await provider.script(key, { outcome, costUsdMicros: outcome === 'success' ? 100 : null })
}

const controller = await Controller.open(
  args.runDir,
  args.objectsRoot,
  {
    runId: 'run-fault',
    budgetLimits: { usd: 1_000_000, 'task-trials': 100 },
    onBoundary: (point) => {
      if (point === args.crashAt) {
        process.kill(process.pid, 'SIGKILL')
      }
    },
  },
  provider,
)

// A resume may find parts of this already durable; every step below is
// idempotent, which is exactly what the harness verifies.
if (controller.state.phase === 'DRAFT') {
  await controller.changePhase('PREFLIGHT', 'fault-harness')
}
if (controller.state.phase === 'PREFLIGHT') {
  await controller.changePhase('CALIBRATED', 'fault-harness')
}
if (controller.state.phase === 'CALIBRATED') {
  await controller.changePhase('SEARCHING', 'fault-harness')
}
if (controller.state.waves['w1'] === undefined) {
  await controller.planWave('w1', 'dev-observed', ['a1', 'a2', 'a3'])
}

const inputs = [
  { actionId: 'a1', candidateId: 'cand-1', opaqueTaskId: 'task-1' },
  { actionId: 'a2', candidateId: 'cand-2', opaqueTaskId: 'task-2' },
  { actionId: 'a3', candidateId: 'cand-3', opaqueTaskId: 'task-3' },
]
for (const input of inputs) {
  await controller.runEvaluation({
    ...input,
    waveId: 'w1',
    attempt: 1,
    split: 'dev-observed',
    estimate: [
      { dimension: 'usd', amount: 500_000 },
      { dimension: 'task-trials', amount: 1 },
    ],
  })
}
await controller.commitWave('w1')
await controller.close()

const status = await readRunStatus(args.runDir, {
  runId: 'run-fault',
  budgetLimits: { usd: 1_000_000, 'task-trials': 100 },
})
const report = {
  phase: status.phase,
  stateHash: status.stateHash,
  actions: status.actions,
  budget: status.budget,
  recovery: controller.recovery,
}
process.stdout.write(`${JSON.stringify(report)}\n`)
