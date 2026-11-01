import type { FinalizedSubmission } from './action-broker.js'
import { executionInputArtifacts } from './input-manifest.js'
/** Independent full-validator feedback for proposal snapshots; never Archive admission. */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import type { BuildInput } from '../builder/pipeline.js'
import { CANDIDATE_TEST_RUN_BUDGET } from '../proposer/tools.js'
import { composeValidatorInputs } from './validator-input.js'
import {
  prepareValidatorPair,
  readValidatorPair,
  collectValidatorPair,
  startNextValidator,
  cancelValidatorPair,
  type ValidatorExecutionProfile,
} from './validator-pair.js'
import { prepareSupervisorDirectory } from './host-directory.js'
import { publishCanonical, readCanonicalFile, verifyExecutionBundle } from './evidence.js'
import { readSourceSnapshot } from './snapshot.js'
import { assertExact, ExecutionError, type ExecutionSpec } from './types.js'
export interface ProposalTestOptions {
  root: string
  store: ObjectStore
  spec: ExecutionSpec
  children: readonly string[]
  parentSnapshot: ObjectRef
  parentCapsuleInventory: ObjectRef
  workerInventory: ObjectRef
  dependencyClosureSha256: string
  profile: ValidatorExecutionProfile
  treeV2ParentEvidence?: BuildInput['treeV2ParentEvidence']
}
export class ProposalValidatorTests {
  private readonly options: ProposalTestOptions
  private operations: Promise<unknown> = Promise.resolve()
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.catch(() => undefined).then(operation)
    this.operations = result
    return result
  }
  constructor(options: ProposalTestOptions) {
    this.options = {
      ...structuredClone({ ...options, store: undefined }),
      store: options.store,
    } as ProposalTestOptions
    if (
      options.profile.kind !== 'test' ||
      options.profile.storeRoot !== options.store.root ||
      options.spec.kind !== 'proposal'
    )
      throw new ExecutionError(
        'online tests require the independent test pool and parent evidence store',
      )
  }
  private async put(value: unknown): Promise<ObjectRef> {
    return this.options.store.put(Buffer.from(canonicalJson(value)), {
      mediaType: 'application/vnd.dsh-evolve-le.proposal-test+json',
      label: 'DEV_OBSERVED',
    })
  }
  private async plans(): Promise<ObjectRef[]> {
    let names: string[]
    try {
      names = await readdir(this.options.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const plans: ObjectRef[] = []
    for (const name of names.sort()) {
      if (name === 'cancel.json') continue
      if (!/^[a-f0-9]{64}$/.test(name)) throw new ExecutionError('invalid proposal test slot')
      try {
        const ref = await readCanonicalFile(join(this.options.root, name, 'plan.json'))
        validateRef(ref)
        plans.push(ref)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return plans
  }
  private async cancelled(): Promise<boolean> {
    try {
      const request = await readCanonicalFile(join(this.options.root, 'cancel.json'))
      assertExact(request, ['specDigest'])
      if (request.specDigest !== canonicalHash(this.options.spec))
        throw new ExecutionError('test cancellation spec mismatch')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  async prepare(child: string, source: ObjectRef): Promise<ObjectRef> {
    const frozen = structuredClone(source)
    return this.serial(() => this.prepareLocked(child, frozen))
  }
  private async prepareLocked(child: string, source: ObjectRef): Promise<ObjectRef> {
    if (!this.options.children.includes(child))
      throw new ExecutionError('online test child allocation mismatch')
    const snapshot = await readSourceSnapshot(this.options.store, source)
    if (
      snapshot.child !== child ||
      snapshot.executionId !== this.options.spec.executionId ||
      snapshot.specDigest !== canonicalHash(this.options.spec)
    )
      throw new ExecutionError('online test source execution mismatch')
    await prepareSupervisorDirectory(this.options.root)
    if (await this.cancelled()) throw new ExecutionError('proposal tests revoked')
    const request = {
      protocol: 'dsh-evolve-le/proposal-test-intent/v1',
      specDigest: canonicalHash(this.options.spec),
      child,
      source,
      parentSnapshot: this.options.parentSnapshot,
      parentCapsuleInventory: this.options.parentCapsuleInventory,
      workerInventory: this.options.workerInventory,
      dependencyClosureSha256: this.options.dependencyClosureSha256,
      profile: this.options.profile,
      ...(this.options.treeV2ParentEvidence
        ? { treeV2ParentEvidence: this.options.treeV2ParentEvidence }
        : {}),
    }
    const slot = join(this.options.root, canonicalHash(request))
    try {
      const ref = await readCanonicalFile(join(slot, 'plan.json'))
      validateRef(ref)
      await this.verifyPlan(ref, child, source)
      if (await this.cancelled()) throw new ExecutionError('proposal tests revoked')
      return ref
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if ((await this.plans()).length >= CANDIDATE_TEST_RUN_BUDGET)
      throw new ExecutionError('proposal test plan budget exhausted')
    await prepareSupervisorDirectory(slot)
    await publishCanonical(join(slot, 'intent.json'), await this.put(request))
    const input = await composeValidatorInputs({
      ...this.options,
      sourceSnapshot: source,
      proposalExecutionId: this.options.spec.executionId,
      proposalSpecDigest: canonicalHash(this.options.spec),
      child,
    })
    const plan = await prepareValidatorPair({
      store: this.options.store,
      parent: this.options.spec,
      child,
      sourceSnapshot: source,
      ...input,
      dependencyClosureSha256: this.options.dependencyClosureSha256,
      profile: this.options.profile,
      ...(this.options.treeV2ParentEvidence
        ? { treeV2ParentEvidence: this.options.treeV2ParentEvidence }
        : {}),
    })
    await publishCanonical(join(slot, 'plan.json'), plan)
    await this.verifyPlan(plan, child, source)
    if (await this.cancelled()) {
      await cancelValidatorPair(this.options.store, plan, 'proposal tests cancelled')
      throw new ExecutionError('proposal tests revoked during preparation')
    }
    return plan
  }
  private async verifyPlan(ref: ObjectRef, child?: string, source?: ObjectRef) {
    const plan = await readValidatorPair(this.options.store, ref)
    const parent = parseCanonicalJson((await this.options.store.read(plan.parent)).toString('utf8'))
    const profile = parseCanonicalJson(
      (await this.options.store.read(plan.profile)).toString('utf8'),
    )
    if (
      canonicalJson(parent) !== canonicalJson(this.options.spec) ||
      canonicalJson(profile) !== canonicalJson(this.options.profile) ||
      plan.configs.some((config) => config.spec.kind !== 'test') ||
      !this.options.children.includes(plan.child) ||
      (child && plan.child !== child) ||
      (source && canonicalJson(plan.sourceSnapshot) !== canonicalJson(source))
    )
      throw new ExecutionError('online validator plan binding mismatch')
    return plan
  }
  async test(
    child: string,
    source: ObjectRef,
  ): Promise<{ ok: boolean; output: string; receipt: ObjectRef }> {
    source = structuredClone(source)
    const planRef = await this.prepare(child, source),
      store = this.options.store
    let aggregate: ObjectRef | null = null
    for (;;) {
      aggregate = await collectValidatorPair(store, planRef)
      if (await this.cancelled()) {
        await cancelValidatorPair(store, planRef, 'proposal tests cancelled')
        throw new ExecutionError('proposal tests revoked')
      }
      if (aggregate) break
      if ((await this.cancelled()) || Date.now() >= Date.parse(this.options.spec.deadlineUtc))
        await cancelValidatorPair(store, planRef, 'proposal tests cancelled')
      if (Date.now() > Date.parse(this.options.spec.deadlineUtc) + 10_000)
        throw new ExecutionError('online test stop unconfirmed; plan retained for reconcile')
      await startNextValidator(store, planRef)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const value = parseCanonicalJson((await store.read(aggregate)).toString('utf8'))
    assertExact(value, ['protocol', 'plan', 'sourceDigest', 'status', 'results', 'validations'])
    if (
      !Array.isArray(value.results) ||
      !['ARTIFACTS_MATCHED', 'FAILED'].includes(String(value.status))
    )
      throw new ExecutionError('invalid online test aggregate')
    const diagnostics: unknown[] = []
    for (const ref of value.results) {
      validateRef(ref)
      const result = parseCanonicalJson((await store.read(ref)).toString('utf8')) as {
        execution?: ObjectRef | null
        outcome?: string
      }
      if (result.execution) {
        const bundle = await verifyExecutionBundle(store, result.execution)
        for (const diagnostic of bundle.artifacts.filter(
          (ref) => ref.mediaType === 'application/vnd.dsh-evolve-le.worker-diagnostic+json',
        ))
          diagnostics.push({
            source: 'worker-reported',
            artifact: diagnostic,
            text: (await store.read(diagnostic)).toString('utf8').slice(0, 4096),
          })
      }
    }
    if (await this.cancelled()) throw new ExecutionError('proposal tests revoked')
    const ok = value.status === 'ARTIFACTS_MATCHED'
    const receipt = await this.put({
      protocol: 'dsh-evolve-le/proposal-test-result/v1',
      specDigest: canonicalHash(this.options.spec),
      child,
      source,
      plan: planRef,
      aggregate,
      ok,
    })
    const plan = await this.verifyPlan(planRef, child, source)
    const slot = join(
      this.options.root,
      canonicalHash({
        protocol: 'dsh-evolve-le/proposal-test-intent/v1',
        specDigest: canonicalHash(this.options.spec),
        child,
        source,
        parentSnapshot: this.options.parentSnapshot,
        parentCapsuleInventory: this.options.parentCapsuleInventory,
        workerInventory: this.options.workerInventory,
        dependencyClosureSha256: this.options.dependencyClosureSha256,
        profile: this.options.profile,
        ...(this.options.treeV2ParentEvidence
          ? { treeV2ParentEvidence: this.options.treeV2ParentEvidence }
          : {}),
      }),
    )
    await publishCanonical(join(slot, 'result.json'), receipt)
    const output = JSON.stringify({
      ok,
      scope: 'development feedback only; not Archive admission',
      sourceDigest: plan.sourceDigest,
      aggregate,
      diagnostics,
    })
    if (await this.cancelled()) throw new ExecutionError('proposal tests revoked')
    return { ok, output: output.slice(0, this.options.spec.limits.outputBytes / 4), receipt }
  }
  async testSubmission(submission: FinalizedSubmission): Promise<void> {
    for (const source of submission.sources) {
      const result = await this.test(source.child, source.source)
      if (!result.ok) throw new ExecutionError(`candidate snapshot tests failed: ${result.output}`)
    }
  }
  async cancel(): Promise<void> {
    await prepareSupervisorDirectory(this.options.root)
    await publishCanonical(join(this.options.root, 'cancel.json'), {
      specDigest: canonicalHash(this.options.spec),
    })
    // Persist revocation immediately; wait for in-flight plan publication before confirming stop.
    return this.serial(() => this.cancelLocked())
  }
  private async cancelLocked(): Promise<void> {
    const plans = await this.plans()
    const requests = await Promise.allSettled(
      plans.map((ref) => cancelValidatorPair(this.options.store, ref, 'proposal tests cancelled')),
    )
    if (requests.some((result) => result.status === 'rejected'))
      throw new ExecutionError('proposal test cancellation fanout incomplete')
    for (const ref of plans) {
      await this.verifyPlan(ref)
      const aggregate = await collectValidatorPair(this.options.store, ref)
      if (!aggregate) throw new ExecutionError('proposal test process stop unconfirmed')
      const value = parseCanonicalJson(
        (await this.options.store.read(aggregate)).toString('utf8'),
      ) as { results: ObjectRef[] }
      for (const resultRef of value.results) {
        const result = parseCanonicalJson(
          (await this.options.store.read(resultRef)).toString('utf8'),
        ) as { outcome: string }
        if (result.outcome === 'INCOMPLETE')
          throw new ExecutionError('proposal test cleanup unconfirmed')
      }
    }
  }
  async artifacts(): Promise<ObjectRef[]> {
    const store = this.options.store,
      refs: ObjectRef[] = []
    for (const ref of await this.plans()) {
      const plan = await this.verifyPlan(ref)
      refs.push(
        ref,
        plan.parent,
        plan.profile,
        ...plan.inputs,
        ...(await executionInputArtifacts(store, plan.inputManifest)),
      )
      const aggregate = await collectValidatorPair(store, ref)
      if (!aggregate) continue
      refs.push(aggregate)
      const value = parseCanonicalJson((await store.read(aggregate)).toString('utf8')) as {
        results: ObjectRef[]
      }
      for (const resultRef of value.results) {
        refs.push(resultRef)
        const result = parseCanonicalJson((await store.read(resultRef)).toString('utf8')) as {
          configuration: ObjectRef
          execution: ObjectRef | null
          failure: ObjectRef | null
        }
        refs.push(result.configuration)
        if (result.failure) refs.push(result.failure)
        if (result.execution) {
          refs.push(result.execution)
          const bundle = await verifyExecutionBundle(store, result.execution)
          refs.push(bundle.spec, ...bundle.receipts, ...bundle.artifacts)
        }
      }
    }
    let slots: string[] = []
    try {
      slots = await readdir(this.options.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const slot of slots.filter((slot) => /^[a-f0-9]{64}$/.test(slot))) {
      for (const name of ['intent.json', 'result.json']) {
        try {
          const ref = await readCanonicalFile(join(this.options.root, slot, name))
          validateRef(ref)
          refs.push(ref)
          const value = parseCanonicalJson((await store.read(ref)).toString('utf8')) as {
            specDigest?: unknown
            source?: ObjectRef
            child?: unknown
            protocol?: unknown
          }
          if (value.specDigest !== canonicalHash(this.options.spec) || !value.source)
            throw new ExecutionError('online test receipt binding mismatch')
          const expectedProtocol =
            name === 'intent.json'
              ? 'dsh-evolve-le/proposal-test-intent/v1'
              : 'dsh-evolve-le/proposal-test-result/v1'
          if (
            value.protocol !== expectedProtocol ||
            (name === 'intent.json' && ref.digest !== slot)
          )
            throw new ExecutionError('online test receipt protocol/slot mismatch')
          const snapshot = await readSourceSnapshot(store, value.source)
          if (
            typeof value.child !== 'string' ||
            !this.options.children.includes(value.child) ||
            snapshot.child !== value.child ||
            snapshot.executionId !== this.options.spec.executionId ||
            snapshot.specDigest !== canonicalHash(this.options.spec)
          )
            throw new ExecutionError('online test artifact snapshot binding mismatch')
          refs.push(value.source, ...snapshot.files.map((file) => file.content))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    const unique = [...new Map(refs.map((ref) => [canonicalJson(ref), ref])).values()]
    await store.scrub(unique)
    return unique
  }
}
