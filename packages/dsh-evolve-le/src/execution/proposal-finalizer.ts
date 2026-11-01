import { CANONICAL_SOURCE_CAPS } from '../candidate/canonical.js'
/** TCB normalization of CAS snapshots; never executes candidate code or touches live workspace. */
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import {
  finalizeTreeV2Bundle,
  type FinalizeTreeV2BundleOptions,
} from '../tree-v2/finalize-bundle.js'
import {
  PROPOSAL_MAX_WIDTH,
  parseProposalOutput,
  type ProposalOutput,
} from '../proposer/protocol.js'
import { prepareSupervisorDirectory } from './host-directory.js'
import { publishCanonical, readCanonicalFile } from './evidence.js'
import { captureSourceSnapshot, materializeSourceSnapshot, readSourceSnapshot } from './snapshot.js'
import { assertExact, ExecutionError, validateExecutionSpec, type ExecutionSpec } from './types.js'
import type { FinalizedSubmission, SubmittedSource } from './action-broker.js'
type Context = Omit<FinalizeTreeV2BundleOptions, 'proposal' | 'childrenRoot' | 'treeV2Parent'> & {
  treeV2Parent?: FinalizeTreeV2BundleOptions['treeV2Parent']
}
export class ProposalSnapshotFinalizer {
  private readonly spec: ExecutionSpec
  private readonly context: Context
  private readonly children: readonly string[]
  constructor(
    private readonly options: {
      root: string
      store: ObjectStore
      spec: ExecutionSpec
      inputManifest: ObjectRef
      context: Context
      children: readonly string[]
    },
  ) {
    this.options = { ...options, inputManifest: structuredClone(options.inputManifest) }
    this.spec = structuredClone(options.spec)
    this.context = structuredClone(options.context)
    this.children = [...options.children]
    validateExecutionSpec(this.spec)
    validateRef(this.options.inputManifest)
    if (
      this.spec.kind !== 'proposal' ||
      !this.children.length ||
      this.children.length > PROPOSAL_MAX_WIDTH ||
      new Set(this.children).size !== this.children.length ||
      this.children.some((child) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(child))
    )
      throw new ExecutionError('invalid finalizer execution/allocation')
    if (
      !/^sha256:[a-f0-9]{64}$/.test(this.context.parentSourceHash) ||
      (this.context.treeV2Parent &&
        this.context.treeV2Parent.candidateDigest !== this.context.parentSourceHash)
    )
      throw new ExecutionError('invalid finalizer parent context')
  }
  private async put(value: unknown): Promise<ObjectRef> {
    return this.options.store.put(Buffer.from(canonicalJson(value)), {
      mediaType: 'application/vnd.dsh-evolve-le.proposal-finalization+json',
      label: 'CONTROLLER_INTERNAL',
    })
  }
  private async sources(sources: readonly SubmittedSource[]): Promise<void> {
    const seen = new Set<string>()
    for (const entry of sources) {
      if (!this.children.includes(entry.child) || seen.has(entry.child))
        throw new ExecutionError('finalizer child allocation mismatch')
      seen.add(entry.child)
      const snapshot = await readSourceSnapshot(this.options.store, entry.source)
      if (
        snapshot.child !== entry.child ||
        snapshot.executionId !== this.spec.executionId ||
        snapshot.specDigest !== canonicalHash(this.spec)
      )
        throw new ExecutionError('finalizer snapshot execution binding mismatch')
    }
  }
  private async readIntent(ref: ObjectRef) {
    const value = parseCanonicalJson((await this.options.store.read(ref)).toString('utf8'))
    assertExact(value, ['protocol', 'specDigest', 'inputManifest', 'proposal', 'sources'])
    if (
      value.protocol !== 'dsh-evolve-le/proposal-finalization-intent/v1' ||
      value.specDigest !== canonicalHash(this.spec) ||
      canonicalJson(value.inputManifest) !== canonicalJson(this.options.inputManifest) ||
      !Array.isArray(value.sources)
    )
      throw new ExecutionError('invalid finalization intent binding')
    const sources: SubmittedSource[] = []
    for (const source of value.sources) {
      assertExact(source, ['child', 'source'])
      if (typeof source.child !== 'string')
        throw new ExecutionError('invalid finalization intent child')
      validateRef(source.source)
      sources.push({ child: source.child, source: source.source })
    }
    await this.sources(sources)
    return { value, sources }
  }
  private async adopt(ref: ObjectRef, intent: ObjectRef): Promise<FinalizedSubmission> {
    const value = parseCanonicalJson((await this.options.store.read(ref)).toString('utf8'))
    assertExact(value, ['protocol', 'intent', 'proposal', 'sources'])
    if (
      value.protocol !== 'dsh-evolve-le/proposal-finalization-result/v1' ||
      canonicalJson(value.intent) !== canonicalJson(intent) ||
      !Array.isArray(value.sources)
    )
      throw new ExecutionError('invalid finalization result binding')
    parseProposalOutput(value.proposal)
    const original = await this.readIntent(intent)
    if (
      value.proposal.parentSourceHash !== this.context.parentSourceHash ||
      canonicalJson(value.proposal.children.map((child) => child.childName).sort()) !==
        canonicalJson(original.sources.map((source) => source.child).sort())
    )
      throw new ExecutionError('finalization result parent/selection mismatch')
    const sources: SubmittedSource[] = []
    for (const source of value.sources) {
      assertExact(source, ['child', 'source'])
      if (typeof source.child !== 'string') throw new ExecutionError('invalid finalizer child')
      validateRef(source.source)
      sources.push({ child: source.child, source: source.source })
    }
    await this.sources(sources)
    if (
      canonicalJson(value.proposal.children.map((child) => child.childName).sort()) !==
      canonicalJson(sources.map((source) => source.child).sort())
    )
      throw new ExecutionError('finalization proposal/source mismatch')
    return { proposal: value.proposal, sources }
  }
  async finalize(
    raw: unknown,
    requested: readonly SubmittedSource[],
  ): Promise<FinalizedSubmission> {
    const proposal = structuredClone(raw),
      sources = structuredClone([...requested])
    if (Buffer.byteLength(canonicalJson(proposal)) > this.spec.limits.outputBytes)
      throw new ExecutionError('raw proposal size limit')
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal))
      throw new ExecutionError('invalid raw proposal')
    const envelope = proposal as {
      schemaVersion?: unknown
      parentSourceHash?: unknown
      children?: unknown
    }
    if (
      envelope.parentSourceHash !== this.context.parentSourceHash ||
      !Array.isArray(envelope.children) ||
      !envelope.children.length ||
      envelope.children.length > this.children.length
    )
      throw new ExecutionError('finalizer proposal parent/width mismatch')
    const names = envelope.children.map((child) => {
      if (!child || typeof child !== 'object' || typeof child.childName !== 'string')
        throw new ExecutionError('invalid finalizer selector')
      return child.childName as string
    })
    if (
      new Set(names).size !== names.length ||
      canonicalJson([...names].sort()) !==
        canonicalJson(sources.map((source) => source.child).sort())
    )
      throw new ExecutionError('finalizer proposal/source selection mismatch')
    await this.sources(sources)
    const intent = await this.put({
      protocol: 'dsh-evolve-le/proposal-finalization-intent/v1',
      specDigest: canonicalHash(this.spec),
      inputManifest: this.options.inputManifest,
      proposal,
      sources,
    })
    const slot = join(this.options.root, intent.digest)
    await prepareSupervisorDirectory(slot)
    await publishCanonical(join(slot, 'intent.json'), intent)
    for (const name of ['result.json', 'failure.json']) {
      try {
        const ref = await readCanonicalFile(join(slot, name))
        validateRef(ref)
        if (name === 'result.json') return await this.adopt(ref, intent)
        const failure = parseCanonicalJson((await this.options.store.read(ref)).toString('utf8'))
        assertExact(failure, ['protocol', 'intent', 'reason', 'sources'])
        if (
          failure.protocol !== 'dsh-evolve-le/proposal-finalization-failure/v1' ||
          canonicalJson(failure.intent) !== canonicalJson(intent) ||
          typeof failure.reason !== 'string'
        )
          throw new ExecutionError('invalid finalization failure binding')
        throw new ExecutionError(failure.reason)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const scratch = await mkdtemp(join(slot, 'scratch-')),
      normalized: SubmittedSource[] = []
    try {
      if (Date.now() >= Date.parse(this.spec.deadlineUtc))
        throw new ExecutionError('finalizer action deadline expired')
      for (const source of sources) {
        const snapshot = await readSourceSnapshot(this.options.store, source.source)
        if (
          snapshot.files.length > CANONICAL_SOURCE_CAPS.maxFiles ||
          snapshot.totalBytes > CANONICAL_SOURCE_CAPS.maxBytes ||
          snapshot.files.some(
            (file) => file.content.size > CANONICAL_SOURCE_CAPS.maxSingleFileBytes,
          )
        )
          throw new ExecutionError('finalizer canonical source limits exceeded')
      }
      if (envelope.schemaVersion !== 2 && this.context.treeV2Parent)
        throw new ExecutionError('proposal version differs from frozen tree-v2 parent')
      if (envelope.schemaVersion === 2) {
        if (!this.context.treeV2Parent)
          throw new ExecutionError('tree-v2 finalization requires frozen parent evidence')
        for (const source of sources) {
          const path = join(scratch, source.child)
          await materializeSourceSnapshot(this.options.store, source.source, path)
          // Only this private TCB copy becomes writable; no candidate process can reach it.
          await chmod(join(path, 'candidate.json'), 0o644)
        }
        await finalizeTreeV2Bundle({
          ...this.context,
          treeV2Parent: this.context.treeV2Parent,
          proposal: proposal as ProposalOutput,
          childrenRoot: scratch,
        })
        for (const source of sources)
          normalized.push({
            child: source.child,
            source: await captureSourceSnapshot({
              root: join(scratch, source.child),
              spec: this.spec,
              store: this.options.store,
              child: source.child,
            }),
          })
      } else normalized.push(...sources)
      parseProposalOutput(proposal)
      if (Date.now() >= Date.parse(this.spec.deadlineUtc))
        throw new ExecutionError('finalizer action deadline expired')
      const result = await this.put({
        protocol: 'dsh-evolve-le/proposal-finalization-result/v1',
        intent,
        proposal,
        sources: normalized,
      })
      const verified = await this.adopt(result, intent)
      await publishCanonical(join(slot, 'result.json'), result)
      return verified
    } catch (error) {
      if (envelope.schemaVersion === 2) {
        for (const source of sources) {
          if (normalized.some((entry) => entry.child === source.child)) continue
          try {
            normalized.push({
              child: source.child,
              source: await captureSourceSnapshot({
                root: join(scratch, source.child),
                spec: this.spec,
                store: this.options.store,
                child: source.child,
              }),
            })
          } catch {
            /* Original immutable sources remain in the intent if private capture is unavailable. */
          }
        }
      }
      const failure = await this.put({
        protocol: 'dsh-evolve-le/proposal-finalization-failure/v1',
        intent,
        reason: (error instanceof Error ? error.message : 'finalizer failed').slice(0, 2048),
        sources: normalized,
      })
      await publishCanonical(join(slot, 'failure.json'), failure)
      throw error
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  async artifacts(): Promise<ObjectRef[]> {
    let slots: string[]
    try {
      slots = await readdir(this.options.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const refs = new Map<string, ObjectRef>()
    for (const slot of slots.sort()) {
      if (!/^[a-f0-9]{64}$/.test(slot)) throw new ExecutionError('invalid finalizer evidence slot')
      for (const name of ['intent.json', 'result.json', 'failure.json']) {
        let ref: unknown
        try {
          ref = await readCanonicalFile(join(this.options.root, slot, name))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        validateRef(ref)
        refs.set(ref.digest, ref)
        if (name === 'intent.json') {
          if (ref.digest !== slot) throw new ExecutionError('finalization slot/intent mismatch')
          await this.readIntent(ref)
        } else {
          const document = parseCanonicalJson(
            (await this.options.store.read(ref)).toString('utf8'),
          ) as { intent?: unknown }
          validateRef(document.intent)
          if (document.intent.digest !== slot)
            throw new ExecutionError('finalization artifact intent mismatch')
          await this.readIntent(document.intent)
          refs.set(document.intent.digest, document.intent)
        }
        const value = parseCanonicalJson((await this.options.store.read(ref)).toString('utf8')) as {
          sources?: SubmittedSource[]
        }
        if (!Array.isArray(value.sources))
          throw new ExecutionError('finalization artifact sources missing')
        await this.sources(value.sources)
        for (const source of value.sources) {
          refs.set(source.source.digest, source.source)
          for (const file of (await readSourceSnapshot(this.options.store, source.source)).files)
            refs.set(file.content.digest, file.content)
        }
      }
    }
    return [...refs.values()]
  }
}
