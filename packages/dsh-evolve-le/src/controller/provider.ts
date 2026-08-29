/**
 * BenchmarkProvider port (Gate 3, specs/07 §5): the only boundary through
 * which the controller touches external evaluation compute. The trusted
 * Harbor adapter arrives in a later gate; the contract here is what the
 * saga's idempotency and reconciliation logic is written against — every
 * effect is keyed, inspectable, and collectable without side effects.
 *
 * Contract (specs/06 §12–13):
 * - `launch` MUST be idempotent per idempotency key: relaunching the same key
 *   returns the same external job with NO second external effect.
 * - `inspect`/`inspectByKey` are read-only.
 * - `collect` returns the terminal fact exactly once per job; repeated calls
 *   return the same fact and never re-bill.
 */
import type { ObservationOutcome } from '../state/reducer.js'

export type ProviderJobStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'LOST' | 'UNKNOWN'

export interface ProviderTerminal {
  outcome: ObservationOutcome
  /** Trusted cost receipt; null when the provider cannot attribute cost. */
  costUsdMicros: number | null
  durationMs: number | null
  /** Raw trajectory bytes; the controller stores them content-addressed. */
  trajectory: Buffer
}

export interface ProviderInspect {
  status: ProviderJobStatus
}

export interface BenchmarkProvider {
  readonly name: string
  /** Idempotent-by-key external launch. */
  launch(request: unknown, idempotencyKey: string): Promise<{ externalJobId: string }>
  /** Read-only status of a known job. */
  inspect(externalJobId: string): Promise<ProviderInspect>
  /** Read-only lookup of a launch that may have happened without a receipt. */
  inspectByKey(
    idempotencyKey: string,
  ): Promise<{ externalJobId: string; status: ProviderJobStatus } | null>
  /** Fetch the terminal fact + trajectory (no side effects, no re-billing). */
  collect(externalJobId: string): Promise<ProviderTerminal>
}

export interface ProviderCounters {
  /** One entry per REAL external launch effect (idempotent re-launch: none). */
  launchEffects: string[]
  /** One entry per collect call. */
  collects: string[]
}

export interface ScriptedResult {
  outcome: ObservationOutcome
  status?: ProviderJobStatus
  costUsdMicros?: number | null
  durationMs?: number | null
  trajectory?: Buffer
  /** Stay RUNNING forever (used to exercise nonterminal recovery). */
  neverTerminal?: boolean
}

/**
 * In-memory provider for tests and fault injection. Outcomes are scripted per
 * idempotency key; unscripted keys get a deterministic success. Effect
 * counters exist precisely so tests can assert "no duplicate external
 * effect" after crash-resume.
 */
export class FakeProvider implements BenchmarkProvider {
  readonly name = 'fake-provider'
  private nextJob = 0
  private readonly jobs = new Map<
    string,
    { externalJobId: string; key: string; result: ScriptedResult }
  >()
  readonly counters: ProviderCounters = { launchEffects: [], collects: [] }

  constructor(private readonly defaultResult: ScriptedResult = { outcome: 'success' }) {}

  script(idempotencyKey: string, result: ScriptedResult): this {
    this.scriptedKeys.set(idempotencyKey, result)
    // Existing jobs capture their result at launch; re-scripting a key also
    // advances already-launched jobs (models "the job later went terminal").
    for (const job of this.jobs.values()) {
      if (job.key === idempotencyKey) job.result = result
    }
    return this
  }

  private readonly scriptedKeys = new Map<string, ScriptedResult>()

  private resultFor(key: string): ScriptedResult {
    return this.scriptedKeys.get(key) ?? this.defaultResult
  }

  private statusOf(result: ScriptedResult): ProviderJobStatus {
    if (result.neverTerminal) return 'RUNNING'
    return result.status ?? 'SUCCEEDED'
  }

  async launch(request: unknown, idempotencyKey: string): Promise<{ externalJobId: string }> {
    void request
    const existing = [...this.jobs.values()].find((job) => job.key === idempotencyKey)
    if (existing) {
      // Idempotent relaunch: the external effect already happened.
      return { externalJobId: existing.externalJobId }
    }
    const externalJobId = `job-${(this.nextJob += 1)}`
    this.counters.launchEffects.push(externalJobId)
    this.jobs.set(externalJobId, {
      externalJobId,
      key: idempotencyKey,
      result: this.resultFor(idempotencyKey),
    })
    return { externalJobId }
  }

  async inspect(externalJobId: string): Promise<ProviderInspect> {
    const job = this.jobs.get(externalJobId)
    if (!job) return { status: 'LOST' }
    return { status: this.statusOf(job.result) }
  }

  async inspectByKey(
    idempotencyKey: string,
  ): Promise<{ externalJobId: string; status: ProviderJobStatus } | null> {
    const job = [...this.jobs.values()].find((candidate) => candidate.key === idempotencyKey)
    if (!job) return null
    return { externalJobId: job.externalJobId, status: this.statusOf(job.result) }
  }

  async collect(externalJobId: string): Promise<ProviderTerminal> {
    const job = this.jobs.get(externalJobId)
    if (!job) {
      throw new Error(`fake-provider: collect of unknown job ${externalJobId}`)
    }
    if (this.statusOf(job.result) === 'RUNNING') {
      throw new Error(`fake-provider: collect of nonterminal job ${externalJobId}`)
    }
    this.counters.collects.push(externalJobId)
    const { result } = job
    return {
      outcome: result.outcome,
      costUsdMicros: result.costUsdMicros ?? null,
      durationMs: result.durationMs ?? null,
      trajectory:
        result.trajectory ??
        Buffer.from(
          `${JSON.stringify({ externalJobId, outcome: result.outcome, key: job.key })}\n`,
          'utf8',
        ),
    }
  }
}
