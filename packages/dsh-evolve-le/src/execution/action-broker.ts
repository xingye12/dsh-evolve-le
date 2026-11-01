/** Trusted action capability consumer; no candidate code executes here. */
import { parseGenerationDraft } from '../proposer/generation-draft.js'
import { join } from 'node:path'
import { canonicalHash, canonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { parseProposalOutput, type ProposalOutput } from '../proposer/protocol.js'
import { CANDIDATE_TEST_RUN_BUDGET } from '../proposer/tools.js'
import {
  NATIVE_PROPOSAL_MAX_FINISH_ATTEMPTS,
  NATIVE_PROPOSAL_TOOL_BUDGET,
} from '../dsh/native-proposal.js'
import { InvocationLog } from './invocations.js'
import { writeCapabilityFile, readCapabilityFile, listCapabilityDirectory } from './files.js'
import { readSourceSnapshot } from './snapshot.js'
import { publishCanonical } from './evidence.js'
import { readSubmission } from './submission.js'
import { type ContainerShell } from './shell.js'
import { assertExact, ExecutionError, type ExecutionSpec } from './types.js'
import type { ActionModelGateway } from './model-gateway.js'
import type { ActionRpcRequest } from './rpc.js'
export interface SubmittedSource {
  child: string
  source: ObjectRef
}
export interface FinalizedSubmission {
  proposal: ProposalOutput
  sources: SubmittedSource[]
}
export class ProposalActionBroker {
  private revoked = false
  private submitted = false
  private paused = false
  private readonly log: InvocationLog
  private readonly refs = new Map<string, ObjectRef>()
  constructor(
    private readonly options: {
      generationOnly?: true
      spec: ExecutionSpec
      inputRoot: string
      workspaceRoot: string
      controlRoot: string
      store: ObjectStore
      children: readonly string[]
      parentSourceHash: string
      shell: ContainerShell
      modelGateway?: ActionModelGateway
      snapshot: (child: string) => Promise<ObjectRef>
      test: (
        child: string,
        source: ObjectRef,
      ) => Promise<{ ok: boolean; output: string; receipt: ObjectRef }>
      finalize: (
        proposal: unknown,
        sources: readonly SubmittedSource[],
      ) => Promise<FinalizedSubmission>
      submitted: (receipt: ObjectRef) => Promise<void>
    },
  ) {
    if (
      options.spec.kind !== 'proposal' ||
      options.children.length === 0 ||
      options.children.length > 16 ||
      new Set(options.children).size !== options.children.length ||
      options.children.some((c) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(c))
    )
      throw new ExecutionError('invalid proposal action allocation')
    this.log = new InvocationLog({
      root: join(options.controlRoot, 'tools'),
      store: options.store,
      executionId: options.spec.executionId,
      maxCalls:
        NATIVE_PROPOSAL_TOOL_BUDGET.refuseAtCalls +
        options.spec.limits.shellCalls +
        CANDIDATE_TEST_RUN_BUDGET +
        NATIVE_PROPOSAL_MAX_FINISH_ATTEMPTS,
      maxBytes: options.spec.limits.outputBytes * 2 + 8192,
    })
  }
  async restore(): Promise<ObjectRef | null> {
    const submission = await readSubmission({
      root: this.options.controlRoot,
      ...(this.options.generationOnly ? { generationOnly: true as const } : {}),
      spec: this.options.spec,
      store: this.options.store,
      children: this.options.children,
      parentSourceHash: this.options.parentSourceHash,
    })
    if (!submission) {
      await this.log.assertSettled()
      return null
    }
    this.submitted = true
    this.options.modelGateway?.revoke()
    for (const ref of submission.artifacts) this.keep(ref)
    return submission.ref
  }
  revoke(): void {
    this.revoked = true
    this.options.modelGateway?.revoke()
  }
  async quiesce(): Promise<void> {
    this.paused = true
    await this.options.modelGateway?.quiesce()
  }
  resume(): void {
    if (!this.revoked && !this.submitted) {
      this.paused = false
      this.options.modelGateway?.resume()
    }
  }
  async drain(): Promise<void> {
    await this.log.drain()
    await this.options.modelGateway?.drain()
  }
  private active(): void {
    if (this.revoked || this.submitted || this.paused)
      throw new ExecutionError('proposal action capability revoked')
    if (Date.now() >= Date.parse(this.options.spec.deadlineUtc))
      throw new ExecutionError('proposal action deadline expired')
  }
  private child(value: unknown): string {
    if (typeof value !== 'string' || !this.options.children.includes(value))
      throw new ExecutionError('child outside preallocated candidate package')
    return value
  }
  private keep(ref: ObjectRef): ObjectRef {
    this.refs.set(ref.digest, ref)
    return ref
  }
  private async capture(child: string): Promise<ObjectRef> {
    const ref = await this.options.snapshot(child),
      snapshot = await readSourceSnapshot(this.options.store, ref)
    if (
      snapshot.child !== child ||
      snapshot.executionId !== this.options.spec.executionId ||
      snapshot.specDigest !== canonicalHash(this.options.spec)
    )
      throw new ExecutionError('snapshot bound to another execution/child')
    this.keep(ref)
    for (const file of snapshot.files) this.keep(file.content)
    return ref
  }
  async handler(request: ActionRpcRequest, signal: AbortSignal): Promise<unknown> {
    this.active()
    if (request.executionId !== this.options.spec.executionId)
      throw new ExecutionError('action execution mismatch')
    if (request.method === 'model') {
      assertExact(request.args, ['payload'])
      if (
        typeof request.args.payload !== 'string' ||
        Buffer.byteLength(request.args.payload) > this.options.spec.limits.outputBytes * 2
      )
        throw new ExecutionError('invalid model request payload')
      if (!this.options.modelGateway)
        throw new ExecutionError('action model gateway unavailable; no fallback')
      const value: unknown = JSON.parse(request.args.payload)
      return this.options.modelGateway.complete(request.invocationId, value, signal)
    }
    if (request.method === 'mutation-count') {
      assertExact(request.args, [])
      return { count: await this.mutationCount() }
    }
    if (request.method === 'event' || request.method === 'cancel-shell')
      throw new ExecutionError('method requires dedicated bounded event/cancellation channel')
    return this.log.invoke(request.invocationId, request.method, request.args, async () => {
      this.active()
      if (signal.aborted) throw new ExecutionError('tool aborted before dispatch')
      const args = request.args
      switch (request.method) {
        case 'read-input': {
          assertExact(args, ['path'])
          if (typeof args.path !== 'string') throw new ExecutionError('invalid read path')
          return {
            content: new TextDecoder('utf-8', { fatal: true }).decode(
              await readCapabilityFile(
                this.options.inputRoot,
                args.path,
                this.options.spec.limits.fileBytes,
              ),
            ),
          }
        }
        case 'list-input': {
          assertExact(args, ['path'])
          if (typeof args.path !== 'string') throw new ExecutionError('invalid list path')
          return {
            files: await listCapabilityDirectory(
              this.options.inputRoot,
              args.path,
              this.options.spec.limits.workspace.inodes,
            ),
          }
        }
        case 'write-child': {
          assertExact(args, ['child', 'path', 'content'])
          const child = this.child(args.child)
          if (typeof args.path !== 'string' || typeof args.content !== 'string')
            throw new ExecutionError('invalid file mutation')
          await writeCapabilityFile(
            join(this.options.workspaceRoot, child),
            args.path,
            Buffer.from(args.content),
            this.options.spec.limits.fileBytes,
            { uid: 65532, gid: 65532 },
          )
          return { writtenBytes: Buffer.byteLength(args.content) }
        }
        case 'shell': {
          assertExact(args, ['command', 'cwd', 'timeoutMs'], ['dshEnv'])
          if (
            typeof args.command !== 'string' ||
            typeof args.cwd !== 'string' ||
            typeof args.timeoutMs !== 'number'
          )
            throw new ExecutionError('invalid shell arguments')
          const count = await this.log.count('shell')
          if (count > this.options.spec.limits.shellCalls)
            throw new ExecutionError('action shell call budget exhausted')
          const result = await this.options.shell.run(this.options.spec, {
            command: args.command,
            cwd: args.cwd,
            timeoutMs: args.timeoutMs,
            invocationId: request.invocationId,
            ...(args.dshEnv === undefined ? {} : { dshEnv: args.dshEnv }),
          })
          this.keep(result.receipt)
          this.keep(result.stdout)
          this.keep(result.stderr)
          return {
            exitCode: result.exitCode,
            receipt: result.receipt,
            stdoutArtifact: result.stdout,
            stderrArtifact: result.stderr,
            stdout: new TextDecoder('utf-8', { fatal: true }).decode(
              await this.options.store.read(result.stdout),
            ),
            stderr: new TextDecoder('utf-8', { fatal: true }).decode(
              await this.options.store.read(result.stderr),
            ),
            receiptDigest: result.receipt.digest,
          }
        }
        case 'snapshot': {
          assertExact(args, ['child'])
          const child = this.child(args.child)
          return { source: await this.capture(child) }
        }
        case 'test-child': {
          assertExact(args, ['child'])
          const child = this.child(args.child)
          if ((await this.log.count('test-child')) > CANDIDATE_TEST_RUN_BUDGET)
            throw new ExecutionError('action candidate test budget exhausted')
          const source = await this.capture(child),
            result = await this.options.test(child, source)
          this.active()
          await this.options.store.verify(result.receipt)
          this.keep(result.receipt)
          if (Buffer.byteLength(result.output) > this.options.spec.limits.outputBytes)
            throw new ExecutionError('candidate test result byte limit')
          return { ...result, source }
        }
        case 'finish': {
          assertExact(args, ['proposal'])
          if ((await this.log.count('finish')) > NATIVE_PROPOSAL_MAX_FINISH_ATTEMPTS)
            throw new ExecutionError('action finish attempts exhausted')
          const proposal = args.proposal
          if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal))
            throw new ExecutionError('invalid raw proposal envelope')
          const raw = proposal as { parentSourceHash?: unknown; children?: unknown }
          if (
            raw.parentSourceHash !== this.options.parentSourceHash ||
            !Array.isArray(raw.children) ||
            raw.children.length === 0 ||
            raw.children.length > this.options.children.length
          )
            throw new ExecutionError('proposal parent/width differs from frozen input')
          const sources: SubmittedSource[] = []
          for (const entry of raw.children) {
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
              throw new ExecutionError('invalid proposal child selector')
            const child = this.child((entry as { childName?: unknown }).childName)
            if (sources.some((s) => s.child === child))
              throw new ExecutionError('duplicate proposal child selector')
            sources.push({ child, source: await this.capture(child) })
          }
          const finalized = await this.options.finalize(proposal, sources)
          this.active()
          const output = finalized.proposal
          if (this.options.generationOnly) parseGenerationDraft(output)
          else parseProposalOutput(output)
          if (output.parentSourceHash !== this.options.parentSourceHash)
            throw new ExecutionError('finalized parent binding mismatch')
          if (
            canonicalJson(output.children.map((c) => c.childName).sort()) !==
            canonicalJson(finalized.sources.map((c) => c.child).sort())
          )
            throw new ExecutionError('finalized source/proposal child mismatch')
          for (const source of finalized.sources) {
            this.child(source.child)
            const snapshot = await readSourceSnapshot(this.options.store, source.source)
            if (
              snapshot.executionId !== this.options.spec.executionId ||
              snapshot.child !== source.child ||
              snapshot.specDigest !== canonicalHash(this.options.spec)
            )
              throw new ExecutionError('final source binding mismatch')
            this.keep(source.source)
            for (const file of snapshot.files) this.keep(file.content)
          }
          const receipt = this.keep(
            await this.options.store.put(
              Buffer.from(
                canonicalJson({
                  protocol: this.options.generationOnly
                    ? 'dsh-evolve-le/generation-submission/v1'
                    : 'dsh-evolve-le/proposal-submission/v1',
                  specDigest: canonicalHash(this.options.spec),
                  executionId: this.options.spec.executionId,
                  proposal: output,
                  sources: finalized.sources,
                }),
              ),
              {
                mediaType: this.options.generationOnly
                  ? 'application/vnd.dsh-evolve-le.generation-submission+json'
                  : 'application/vnd.dsh-evolve-le.proposal-submission+json',
                label: 'CONTROLLER_INTERNAL',
              },
            ),
          )
          this.active()
          await publishCanonical(join(this.options.controlRoot, 'submitted.json'), receipt)
          this.submitted = true
          await this.options.submitted(receipt)
          return { proposal: output, receipt, sources: finalized.sources }
        }
      }
    })
  }
  async mutationCount(): Promise<number> {
    return (await this.log.count('write-child')) + (await this.log.count('shell'))
  }
  async artifacts(): Promise<ObjectRef[]> {
    // Reconstruct only TCB-defined reference fields, never arbitrary refs in
    // candidate-authored proposal text or file contents.
    for (const completed of await this.log.results()) {
      if (
        completed.value === null ||
        typeof completed.value !== 'object' ||
        Array.isArray(completed.value)
      )
        continue
      const value = completed.value as Record<string, unknown>
      const direct =
        completed.method === 'shell'
          ? ['receipt', 'stdoutArtifact', 'stderrArtifact']
          : completed.method === 'test-child'
            ? ['receipt', 'source']
            : completed.method === 'snapshot'
              ? ['source']
              : completed.method === 'finish'
                ? ['receipt']
                : []
      for (const key of direct) {
        validateRef(value[key])
        await this.options.store.verify(value[key])
        this.keep(value[key])
      }
      const sources: Array<{ source: unknown }> = []
      if ((completed.method === 'snapshot' || completed.method === 'test-child') && value.source)
        sources.push({ source: value.source })
      if (completed.method === 'finish' && Array.isArray(value.sources))
        for (const entry of value.sources) {
          if (entry === null || typeof entry !== 'object' || !('source' in entry))
            throw new ExecutionError('invalid stored submission sources')
          sources.push({ source: entry.source })
        }
      for (const source of sources) {
        validateRef(source.source)
        const snapshot = await readSourceSnapshot(this.options.store, source.source)
        if (
          snapshot.specDigest !== canonicalHash(this.options.spec) ||
          snapshot.executionId !== this.options.spec.executionId
        )
          throw new ExecutionError('stored source from another execution')
        this.keep(source.source)
        for (const file of snapshot.files) this.keep(file.content)
      }
    }
    return [
      ...(await this.log.artifacts()),
      ...this.refs.values(),
      ...((await this.options.modelGateway?.artifacts()) ?? []),
    ]
  }
}
