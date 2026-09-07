/**
 * File-backed fake BenchmarkProvider for the crash/fault harness and local
 * development only — NOT a production adapter. The whole point of the harness
 * is that "external" evaluation compute survives controller death: the
 * provider's job table and effect counters live in a JSON file next to the
 * evidence root, so a killed controller process and its resume see the same
 * external world, and the harness can assert from outside that no boundary
 * produced a duplicate launch effect, score, or cost.
 *
 * The provider file is written whole (tmp + rename) after every mutation so a
 * crash mid-mutation never exposes a torn job table.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ObservationOutcome } from '../state/reducer.js'
import type { BenchmarkProvider, ProviderJobStatus, ProviderTerminal } from './provider.js'

interface FileJob {
  externalJobId: string
  key: string
  outcome: ObservationOutcome
  status: ProviderJobStatus
  costUsdMicros: number | null
  durationMs: number | null
  solverTokens: number | null
  trajectoryBase64: string | null
}

interface ProviderFile {
  schemaVersion: 1
  /** One entry per REAL external launch effect. */
  launchEffects: string[]
  /** One entry per collect call (collect is free; launches are the cost). */
  collects: string[]
  jobs: FileJob[]
  /** Outcomes scripted for keys before (or after) their launch. */
  defaults: Record<string, { outcome: ObservationOutcome; costUsdMicros: number | null }>
}

const EMPTY: ProviderFile = {
  schemaVersion: 1,
  launchEffects: [],
  collects: [],
  jobs: [],
  defaults: {},
}

export class FileProvider implements BenchmarkProvider {
  readonly name = 'file-provider'
  private file: ProviderFile = EMPTY

  private constructor(readonly path: string) {}

  static async open(path: string): Promise<FileProvider> {
    const provider = new FileProvider(path)
    provider.file = await provider.load()
    return provider
  }

  private async load(): Promise<ProviderFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as ProviderFile
      if (parsed.schemaVersion !== 1) {
        throw new Error(`file-provider: unsupported schema ${String(parsed.schemaVersion)}`)
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY }
      throw error
    }
  }

  private async persist(next: ProviderFile): Promise<void> {
    this.file = next
    const staging = join(dirname(this.path), `.${randomUUID()}.provider.tmp`)
    await writeFile(staging, `${JSON.stringify(next)}\n`, 'utf8')
    await rename(staging, this.path)
  }

  /** Harness hook: script a key's outcome (existing jobs advance too). */
  async script(
    key: string,
    result: {
      outcome: ObservationOutcome
      status?: ProviderJobStatus
      costUsdMicros?: number | null
    },
  ): Promise<void> {
    const jobs = this.file.jobs.map((job) =>
      job.key === key
        ? {
            ...job,
            outcome: result.outcome,
            status: result.status ?? job.status,
            costUsdMicros: result.costUsdMicros ?? null,
          }
        : job,
    )
    await this.persist({
      ...this.file,
      jobs,
      defaults: {
        ...this.file.defaults,
        [key]: { outcome: result.outcome, costUsdMicros: result.costUsdMicros ?? null },
      },
    })
  }

  private jobFor(key: string): FileJob | undefined {
    return this.file.jobs.find((job) => job.key === key)
  }

  async launch(request: unknown, idempotencyKey: string): Promise<{ externalJobId: string }> {
    void request
    const existing = this.jobFor(idempotencyKey)
    if (existing) return { externalJobId: existing.externalJobId } // no new effect
    const externalJobId = `job-${this.file.jobs.length + 1}`
    const preset = this.file.defaults[idempotencyKey]
    const job: FileJob = {
      externalJobId,
      key: idempotencyKey,
      outcome: preset?.outcome ?? 'success',
      status: 'SUCCEEDED',
      // An explicitly scripted null cost must survive (nullish coalescing
      // here would silently re-price unpriced usage).
      costUsdMicros: preset !== undefined ? preset.costUsdMicros : 100,
      durationMs: 5_000,
      // The harness provider never runs a live solver route (ADR-030).
      solverTokens: null,
      trajectoryBase64: null,
    }
    await this.persist({
      ...this.file,
      launchEffects: [...this.file.launchEffects, externalJobId],
      jobs: [...this.file.jobs, job],
    })
    return { externalJobId }
  }

  async inspect(externalJobId: string): Promise<{ status: ProviderJobStatus }> {
    const job = this.file.jobs.find((candidate) => candidate.externalJobId === externalJobId)
    if (!job) return { status: 'LOST' }
    return { status: job.status }
  }

  async inspectByKey(
    idempotencyKey: string,
  ): Promise<{ externalJobId: string; status: ProviderJobStatus } | null> {
    const job = this.jobFor(idempotencyKey)
    if (!job) return null
    return { externalJobId: job.externalJobId, status: job.status }
  }

  async collect(externalJobId: string): Promise<ProviderTerminal> {
    const job = this.file.jobs.find((candidate) => candidate.externalJobId === externalJobId)
    if (!job) throw new Error(`file-provider: collect of unknown job ${externalJobId}`)
    if (job.status === 'RUNNING') {
      throw new Error(`file-provider: collect of nonterminal job ${externalJobId}`)
    }
    // collect is read-only externally: record the call, never a new effect.
    await this.persist({ ...this.file, collects: [...this.file.collects, externalJobId] })
    const trajectory =
      job.trajectoryBase64 !== null
        ? Buffer.from(job.trajectoryBase64, 'base64')
        : Buffer.from(
            `${JSON.stringify({ externalJobId, key: job.key, outcome: job.outcome })}\n`,
            'utf8',
          )
    return {
      outcome: job.outcome,
      costUsdMicros: job.costUsdMicros,
      durationMs: job.durationMs,
      solverTokens: job.solverTokens,
      trajectory,
    }
  }

  /** Read-only counters for harness assertions. */
  counters(): { launchEffects: string[]; collects: string[] } {
    return { launchEffects: [...this.file.launchEffects], collects: [...this.file.collects] }
  }
}
