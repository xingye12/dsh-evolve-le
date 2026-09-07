/** ACP-backed tools for the native DSH solve agent.
 *
 * The native agent loop owns model turns and dispatch. These definitions only
 * translate the bounded workspace capability into ACP calls, preserving the
 * same Harbor-observable effects as the compatibility solver.
 */

import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'

type ToolRuntime = {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    timeoutMs?: number
    output: {
      schema: Record<string, unknown>
      render: (args: unknown, value: unknown) => unknown[]
    }
    execute(args: unknown, exec: unknown): Promise<unknown>
  }): () => void
}

function toolsOf(ctx: Context): ToolRuntime | undefined {
  const direct = (ctx as unknown as { tools?: ToolRuntime }).tools
  if (direct !== undefined && typeof direct.register === 'function') return direct
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  const provided = get.call(ctx, 'tools') as ToolRuntime | undefined
  return provided !== undefined && typeof provided.register === 'function' ? provided : undefined
}

const objectSchema = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties,
  additionalProperties: false,
})

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
}

interface NativeSolveToolOptions {
  connection: AgentSideConnection
  sessionId: string
  cwd: string
  commandTimeoutMs?: number
}

function signalOf(exec: unknown): AbortSignal | undefined {
  if (exec === null || typeof exec !== 'object') return undefined
  const signal = (exec as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : undefined
}

/** Register one solve agent's ACP capability surface in its Fiber. */
export function installNativeSolveTools(
  agentCtx: Context,
  options: NativeSolveToolOptions,
): () => void {
  const tools = toolsOf(agentCtx)
  if (tools === undefined) throw new Error('native solve: ctx.tools is unavailable in agent scope')
  const disposers: Array<() => void> = []
  const register = (definition: Parameters<ToolRuntime['register']>[0]): void => {
    disposers.push(tools.register(definition))
  }
  const commandTimeoutMs = options.commandTimeoutMs ?? 300_000

  register({
    name: 'solve_exec',
    description: 'Run a command in the Terminal-Bench workspace and inspect its output.',
    parameters: objectSchema({
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
    }),
    timeoutMs: commandTimeoutMs,
    output: textOutput,
    async execute(args, exec) {
      const input = args as { command?: unknown; args?: unknown }
      if (typeof input.command !== 'string' || input.command.length === 0) {
        throw new Error('command must be a non-empty string')
      }
      if (
        input.args !== undefined &&
        (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string'))
      ) {
        throw new Error('args must be an array of strings')
      }
      const signal = signalOf(exec)
      if (signal?.aborted) throw new Error('solve_exec aborted before terminal creation')
      const handle = await options.connection.createTerminal({
        sessionId: options.sessionId,
        command: input.command,
        ...(input.args === undefined ? {} : { args: input.args as string[] }),
        cwd: options.cwd,
      })
      let timer: NodeJS.Timeout | undefined
      let abortListener: (() => void) | undefined
      let killPromise: Promise<void> | undefined
      const killOnce = (): Promise<void> => {
        if (killPromise === undefined) {
          killPromise = handle
            .kill()
            .then(() => undefined)
            .catch(() => undefined)
        }
        return killPromise
      }
      try {
        if (signal?.aborted) {
          await killOnce()
          await handle.waitForExit().catch(() => undefined)
          throw new Error('solve_exec aborted and terminal was killed')
        }
        const aborted =
          signal === undefined
            ? undefined
            : new Promise<'aborted'>((resolve) => {
                abortListener = () => {
                  resolve('aborted')
                  void killOnce()
                }
                signal.addEventListener('abort', abortListener, { once: true })
              })
        const exit = await Promise.race([
          handle.waitForExit().then((value) => ({ kind: 'exit' as const, value })),
          new Promise<{ kind: 'timeout'; value: 'timeout' }>((resolve) => {
            timer = setTimeout(
              () => resolve({ kind: 'timeout', value: 'timeout' }),
              commandTimeoutMs,
            )
          }),
          ...(aborted === undefined
            ? []
            : [aborted.then((value) => ({ kind: 'aborted' as const, value }))]),
        ])
        if (exit.kind === 'timeout') {
          await killOnce()
          await handle.waitForExit().catch(() => undefined)
          const output = await handle.currentOutput().catch(() => ({ output: '' }))
          return `[exec TIMEOUT after ${String(commandTimeoutMs)}ms, killed]\n${output.output}`
        }
        if (exit.kind === 'aborted') {
          await killOnce()
          await handle.waitForExit().catch(() => undefined)
          throw new Error('solve_exec aborted and terminal was killed')
        }
        const output = await handle.currentOutput().catch(() => ({ output: '' }))
        const code = (exit.value as { exitCode?: number | null }).exitCode
        return `[exec exitCode=${String(code)}]\n${output.output}`
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener)
        await handle.release().catch(() => undefined)
      }
    },
  })

  register({
    name: 'solve_read',
    description: 'Read a text file from the Terminal-Bench workspace.',
    parameters: objectSchema({ path: { type: 'string' } }),
    output: textOutput,
    async execute(args, exec) {
      const path = (args as { path?: unknown }).path
      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error('path must be an absolute path')
      }
      if (signalOf(exec)?.aborted) throw new Error('solve_read aborted before file read')
      const result = await options.connection.readTextFile({ sessionId: options.sessionId, path })
      return `[read ${path}]\n${result.content}`
    },
  })

  register({
    name: 'solve_write',
    description: 'Write complete text content to a file in the Terminal-Bench workspace.',
    parameters: objectSchema({ path: { type: 'string' }, content: { type: 'string' } }),
    output: textOutput,
    async execute(args, exec) {
      const input = args as { path?: unknown; content?: unknown }
      if (typeof input.path !== 'string' || !input.path.startsWith('/')) {
        throw new Error('path must be an absolute path')
      }
      if (typeof input.content !== 'string') throw new Error('content must be a string')
      if (signalOf(exec)?.aborted) throw new Error('solve_write aborted before file write')
      await options.connection.writeTextFile({
        sessionId: options.sessionId,
        path: input.path,
        content: input.content,
      })
      return `[write ${input.path}] wrote ${String(input.content.length)} chars`
    },
  })

  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
