/**
 * Gate 3 controller-service spike: boot the real Cordis Loader against the
 * controller-service composition, drive one full evaluation wave THROUGH the
 * service facade, unload the Loader, and verify from the same process that
 * the flush left nothing behind — snapshot durable at the final seq, writer
 * lock released, no leaked Cordis runtime or process handle — then exit
 * naturally so a lingering handle would hang the process and fail the
 * caller's timeout (same quiescence discipline as the Gate 0 spike).
 *
 * Usage: `node lib/bin/controller-spike.js <cordis.yml> <evidenceDir>`
 * stdout is a single JSON document; exit 0 when quiescent and flushed.
 * @module @dsh-evolve-le/core/bin/controller-spike
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { bootLoader } from '../cordis/boot.js'
import {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type ProcessHandleInventory,
} from '../cordis/inventory.js'
import { LOCK_FILE } from '../controller/lock.js'
import { readRunStatus } from '../controller/controller.js'
import type { DshEvolveControllerService } from '../service/controller-service.js'
import { SNAPSHOT_DIR } from '../state/snapshot.js'

interface SpikeReport {
  config: string
  evidence: string
  phases: {
    before: CordisInventory
    afterBoot: CordisInventory
    afterUnload: CordisInventory
  }
  handles: { before: ProcessHandleInventory; afterUnload: ProcessHandleInventory }
  flush: {
    lockReleased: boolean
    snapshotFiles: string[]
    finalSeq: number
    actions: Array<{ actionId: string; status: string }>
    stateHash: string
  }
  quiescent: boolean
  error?: string
}

async function main(argv: string[]): Promise<number> {
  const [configArg, evidenceArg] = argv
  if (configArg === undefined || evidenceArg === undefined) {
    process.stderr.write('usage: controller-spike <cordis.yml> <evidenceDir>\n')
    return 2
  }
  const configPath = isAbsolute(configArg) ? configArg : resolve(process.cwd(), configArg)
  if (!existsSync(configPath)) {
    process.stderr.write(`config not found: ${configPath}\n`)
    return 2
  }
  // Relative data paths inside the composition resolve from cwd.
  process.chdir(evidenceArg)

  const ctx = new Context()
  const before = snapshotCordisInventory(ctx)
  const handlesBefore = snapshotProcessHandles()

  let booted: Awaited<ReturnType<typeof bootLoader>> | undefined
  try {
    booted = await bootLoader(configPath, { context: ctx })
  } catch (error) {
    const report: SpikeReport = {
      config: configPath,
      evidence: evidenceArg,
      phases: { before, afterBoot: before, afterUnload: before },
      handles: { before: handlesBefore, afterUnload: handlesBefore },
      flush: { lockReleased: false, snapshotFiles: [], finalSeq: -1, actions: [], stateHash: '' },
      quiescent: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return 2
  }

  const afterBoot = snapshotCordisInventory(ctx)
  const service = ctx.get('dshEvolveController') as DshEvolveControllerService | undefined
  if (service === undefined) {
    process.stdout.write(
      `${JSON.stringify({
        error: 'dshEvolveController service not present after boot',
      })}\n`,
    )
    await booted.loaderFiber.dispose()
    return 2
  }

  // Drive one full wave through the service facade — the real controller
  // under the real Loader, not a test harness shortcut.
  await service.changePhase('PREFLIGHT', 'controller-spike')
  await service.changePhase('CALIBRATED', 'controller-spike')
  await service.changePhase('SEARCHING', 'controller-spike')
  await service.planWave('w1', 'dev-observed', ['a1', 'a2'])
  await service.runEvaluation({
    actionId: 'a1',
    waveId: 'w1',
    candidateId: 'cand-1',
    opaqueTaskId: 'task-1',
    attempt: 1,
    split: 'dev-observed',
    estimate: [
      { dimension: 'usd', amount: 500_000 },
      { dimension: 'task-trials', amount: 1 },
    ],
  })
  await service.runEvaluation({
    actionId: 'a2',
    waveId: 'w1',
    candidateId: 'cand-2',
    opaqueTaskId: 'task-2',
    attempt: 1,
    split: 'dev-observed',
    estimate: [
      { dimension: 'usd', amount: 500_000 },
      { dimension: 'task-trials', amount: 1 },
    ],
  })
  await service.commitWave('w1')

  // Unload: dispose() awaits the service's async flush disposer.
  await booted.loaderFiber.dispose()
  // A just-completed FS promise request stays in getActiveResourcesInfo()
  // until the next macrotask retires it; drain one tick so the census below
  // measures real leaks, not completed-work bookkeeping. A genuinely leaked
  // handle survives the tick — and would also hang the natural exit below.
  await new Promise<void>((done) => setImmediate(done))
  const afterUnload = snapshotCordisInventory(ctx)
  const handlesAfter = snapshotProcessHandles()

  // Flush verification from disk, not from the disposed service.
  const runDir = join(evidenceArg, 'runs/run-e2e')
  const lockReleased = !existsSync(join(runDir, LOCK_FILE))
  const snapshotDir = join(runDir, SNAPSHOT_DIR)
  const snapshotFiles = (await readdir(snapshotDir).catch(() => [])).filter((name) =>
    name.startsWith('state-'),
  )
  const status = await readRunStatus(runDir, {
    runId: 'run-e2e',
    budgetLimits: { usd: 1_000_000, 'task-trials': 100 },
  })
  // The latest snapshot must cover the final seq (flush wrote it on close).
  const latestSeq = Math.max(
    ...snapshotFiles.map((name) =>
      Number(name.slice('state-'.length, name.indexOf('-', 'state-'.length))),
    ),
  )

  const quiescent =
    JSON.stringify(afterUnload) === JSON.stringify(before) &&
    JSON.stringify(handlesAfter) === JSON.stringify(handlesBefore)
  const flushed = lockReleased && snapshotFiles.length > 0 && latestSeq === status.seq
  const report: SpikeReport = {
    config: configPath,
    evidence: evidenceArg,
    phases: { before, afterBoot, afterUnload },
    handles: { before: handlesBefore, afterUnload: handlesAfter },
    flush: {
      lockReleased,
      snapshotFiles,
      finalSeq: status.seq,
      actions: status.actions.map((action) => ({
        actionId: action.actionId,
        status: action.status,
      })),
      stateHash: status.stateHash,
    },
    quiescent,
  }
  if (!flushed || !quiescent) {
    report.error = `flush incomplete (lockReleased=${lockReleased}, snapshots=${snapshotFiles.join(',')}, latestSeq=${latestSeq}, statusSeq=${status.seq}) or not quiescent`
  }
  // Touch the committed journal one last time so a leaked handle would show.
  await readFile(join(runDir, 'journal/HEAD'), 'utf8').catch(() => '')
  process.stdout.write(`${JSON.stringify(report)}\n`)
  return report.error === undefined ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
