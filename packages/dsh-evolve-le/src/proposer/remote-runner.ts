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
import type { ModelRouteConfig } from '../config/run-config.js'
import type { ProposalRunner } from '../controller/controller.js'
import {
  openRemoteModelProxy,
  remoteRoutePlanHash,
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
  maxTotalTokens: 4_000_000,
  maxCostUsdMicros: 4_000_000, // $4.00 per proposal action at frozen prices
}

/** Map a frozen route document onto the proxy's route plan. */
export function remoteRoutePlanOf(route: ModelRouteConfig): RemoteRoutePlan {
  if (route.provider !== 'zen-compatible') {
    throw new Error(`remote route requires a zen-compatible provider (got ${route.provider})`)
  }
  if (route.baseUrl === undefined || route.model === undefined) {
    throw new Error(`route ${route.id}: zen-compatible routes need baseUrl and model`)
  }
  return {
    routeId: route.id,
    baseUrl: route.baseUrl,
    model: route.model,
    temperature: route.temperature ?? 0,
    maxOutputTokens: route.maxOutputTokens,
    inputUsdPerMTok: route.inputUsdMicrosPerMTok / 1_000_000,
    outputUsdPerMTok: route.outputUsdMicrosPerMTok / 1_000_000,
  }
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
    const proxy = openRemoteModelProxy({
      socketPath: join(socketDir, 'gw.sock'),
      receiptsPath,
      plan,
      credential: options.credential,
      budget: options.budget ?? REMOTE_PROPOSER_BUDGET,
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
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
        },
      })
    } finally {
      await proxy.close().catch(() => undefined)
      await rm(socketDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
