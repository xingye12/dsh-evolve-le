/**
 * Proxy-backed proposal runner (Gate 8, specs/05 §7): wraps the one-shot
 * sandbox runner for a zen-compatible (networked) proposer route. The
 * controller process — the ONLY credential holder — opens the TCB proxy on a
 * Unix socket, runs the sandbox with its model adapter pointed at that socket,
 * and closes the proxy when the worker exits. The sandbox itself stays
 * networkless; AF_UNIX filesystem sockets cross the network namespace by
 * design, which is the single deliberate hole through it.
 *
 * Layout per sandbox:
 *
 * ```text
 * <sandboxRoot>-remote/remote-receipts.jsonl   # proxy receipts (durable)
 * <tmpdir>/dsh-gw-XXXX/gw.sock                 # socket (short AF_UNIX path,
 *                                              # removed after the run)
 * ```
 *
 * Receipts live beside the sandbox so a crash-resume finds them with the
 * supervisor manifest; the socket lives under tmpdir because real run roots
 * can exceed the 108-byte AF_UNIX path limit and its path never enters any
 * content-addressed document.
 * @module @dsh-evolve-le/core/proposer/remote-runner
 */

import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureCanonicalSource } from '../candidate/canonical.js'
import type { ModelRouteConfig, RunConfig } from '../config/run-config.js'
import type { ProposalRunner } from '../controller/controller.js'
import {
  DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
  openRemoteModelProxy,
  remoteRoutePlanHash,
  retryWorstCaseMs,
  type RemoteRoutePlan,
} from './remote-gateway.js'
import { runProposalSandbox } from './sandbox.js'
import type { GatewayBudget } from './gateway.js'

/**
 * Hard per-proposal ceiling for networked routes (specs/05 §7): the worker's
 * in-sandbox gateway keeps its own character-based stop, but the authoritative
 * one is here, enforced before a request leaves the controller process.
 */
export const REMOTE_PROPOSER_BUDGET: GatewayBudget = {
  maxRequests: 64,
  // ADR-035: attempt 8 burned 4.10-4.16M cumulative tokens authoring full
  // child trees, so the old 4M cap discarded the (paid-for) submission
  // response. 6M gives headroom; 3 x 6M = 18M <= the frozen run-level
  // proposerTokens (20M). The post-hoc check stays hard: when it fires, the
  // just-paid response is discarded rather than the cap being exceeded.
  maxTotalTokens: 6_000_000,
  maxCostUsdMicros: 4_000_000, // $4.00 per proposal action at frozen prices
}

/**
 * Per-request upstream timeout for live routes: observed in the Gate 8 smoke,
 * reasoning-model turns on large writeChild directives exceed the 120s proxy
 * default. The worker's socket client gets this + margin automatically.
 */
export const LIVE_ROUTE_REQUEST_TIMEOUT_MS = 600_000

/** Map a frozen route document onto the proxy's route plan. */
export function remoteRoutePlanOf(route: ModelRouteConfig): RemoteRoutePlan {
  if (route.provider !== 'zen-compatible') {
    throw new Error(`remote route requires a zen-compatible provider (got ${route.provider})`)
  }
  if (route.baseUrl === undefined || route.model === undefined) {
    throw new Error(`route ${route.id}: zen-compatible routes need baseUrl and model`)
  }
  // validateRunConfig requires the ADR-033 policy; a caller that bypassed
  // validation must still fail closed instead of freezing an implicit policy.
  if (route.retry === undefined) {
    throw new Error(`route ${route.id}: zen-compatible routes need a retry policy (ADR-033)`)
  }
  return {
    routeId: route.id,
    baseUrl: route.baseUrl,
    model: route.model,
    temperature: route.temperature ?? 0,
    maxOutputTokens: route.maxOutputTokens,
    inputUsdPerMTok: route.inputUsdMicrosPerMTok / 1_000_000,
    outputUsdPerMTok: route.outputUsdMicrosPerMTok / 1_000_000,
    retry: route.retry,
  }
}

/**
 * The frozen route plan for the run's live SOLVER route (ADR-030), or null
 * when no solver route is configured (replay solves — Gate 8 behavior). The
 * solve gateway and the proposer proxy share the plan shape and hash so one
 * receipt format binds both to the same route table.
 */
export function solverRoutePlan(
  config: Pick<RunConfig, 'modelRoutes' | 'solverRoute'>,
): RemoteRoutePlan | null {
  if (config.solverRoute === undefined) return null
  const route = config.modelRoutes.find((candidate) => candidate.id === config.solverRoute)
  // validateRunConfig already rejects an unknown solverRoute; a caller that
  // reaches here with one bypassed validation must not get a replay in return.
  if (route === undefined) {
    throw new Error(`solver route ${config.solverRoute} is not in the route table`)
  }
  return remoteRoutePlanOf(route)
}

export function remoteProposalRunner(options: {
  route: ModelRouteConfig
  /** Read by the controller into memory; never written anywhere (rule 8). */
  credential: string
  budget?: GatewayBudget
  requestTimeoutMs?: number
}): ProposalRunner {
  const plan = remoteRoutePlanOf(options.route)
  const routeHash = remoteRoutePlanHash(plan)
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS
  // ADR-033: the proxy retries transient failures inside `retryTotalBudgetMs`;
  // reasoning models can also spend minutes on one large turn, so the
  // worker's socket client must outlast the whole retry loop or it would
  // race the reply.
  const retryTotalBudgetMs = retryWorstCaseMs(plan.retry, requestTimeoutMs)
  const clientTimeoutMs = retryTotalBudgetMs + 30_000
  return async (runOptions) => {
    const remoteDir = `${runOptions.sandboxRoot}-remote`
    const receiptsPath = join(remoteDir, 'remote-receipts.jsonl')
    // A crashed earlier attempt may have left a partial chain; the proxy
    // numbers requestIds from req-1, so the file must start empty.
    await rm(remoteDir, { recursive: true, force: true })
    await mkdir(remoteDir, { recursive: true, mode: 0o755 })
    const socketDir = await mkdtemp(join(tmpdir(), 'dsh-gw-'))
    // mkdtemp is 0700 root-only; the worker uid must traverse to the socket.
    await chmod(socketDir, 0o755)
    // ADR-038: the same canonical capture the sandbox staging uses becomes
    // the proxy's parent source view, so `candidate-tests` merged views are
    // verified against the exact bytes the builder will diff against.
    const parentSource = await captureCanonicalSource(runOptions.parentTreeDir)
    const parentSourceFiles: Record<string, string> = {}
    for (const file of parentSource.files) {
      parentSourceFiles[file.path] = file.content.toString('utf8')
    }
    const proxy = openRemoteModelProxy({
      socketPath: join(socketDir, 'gw.sock'),
      receiptsPath,
      plan,
      credential: options.credential,
      budget: options.budget ?? REMOTE_PROPOSER_BUDGET,
      requestTimeoutMs,
      retryTotalBudgetMs,
      parentSourceFiles,
      // ADR-038: the real candidate-test runner stages the merged view as
      // bare source files and symlinks the PARENT CAPSULE's node_modules into
      // it — the child's dependency closure is by contract the parent's
      // (package.json is fixed), so the capsule closure is the test closure.
      candidateDependencyRoot: runOptions.capsuleDir,
      // The worker is uid 65534 in its own netns; connect needs write on the
      // socket file. Receipts stay root-only (hashes only, but why share them).
      socketMode: 0o666,
    })
    try {
      await proxy.ready()
      return await runProposalSandbox({
        ...runOptions,
        model: {
          kind: 'remote',
          socketPath: proxy.socketPath,
          routeId: plan.routeId,
          routeHash,
          receiptsPath,
          clientTimeoutMs,
          provider: options.route.provider,
          model: plan.model,
          maxTokens: plan.maxOutputTokens,
        },
      })
    } finally {
      await proxy.close().catch(() => undefined)
      await rm(socketDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
