import { describe, expect, it } from 'vitest'
import { installNativeSolveTools } from '../src/acp/native-solve-tools.js'

type Definition = {
  name: string
  execute(args: unknown, exec?: unknown): Promise<unknown>
}

describe('native DSH solve tools', () => {
  it('kills and releases a running terminal when the DSH execution is aborted', async () => {
    const definitions: Definition[] = []
    const disposers: Array<() => void> = []
    let resolveExit: ((value: { exitCode: number }) => void) | undefined
    let exited: { exitCode: number } | undefined
    let killed = 0
    let released = 0
    const terminal = {
      waitForExit: () =>
        exited === undefined
          ? new Promise<{ exitCode: number }>((resolve) => {
              resolveExit = resolve
            })
          : Promise.resolve(exited),
      async kill() {
        killed += 1
        exited = { exitCode: 137 }
        resolveExit?.(exited)
      },
      async currentOutput() {
        return { output: '' }
      },
      async release() {
        released += 1
      },
    }
    const ctx = {
      tools: {
        register(definition: Definition) {
          definitions.push(definition)
          const dispose = () => undefined
          disposers.push(dispose)
          return dispose
        },
      },
    } as never
    const connection = {
      async createTerminal() {
        return terminal
      },
    } as never
    const dispose = installNativeSolveTools(ctx, {
      connection,
      sessionId: 'session-1',
      cwd: '/workspace',
    })
    const exec = definitions.find((definition) => definition.name === 'solve_exec')
    expect(exec).toBeDefined()
    const controller = new AbortController()
    const running = exec!.execute({ command: 'sleep', args: ['60'] }, { signal: controller.signal })
    controller.abort()
    await expect(running).rejects.toThrow(/aborted and terminal was killed/)
    expect(killed).toBe(1)
    expect(released).toBe(1)
    dispose()
    expect(disposers).toHaveLength(3)
  })

  it('rejects already-aborted read and write calls before touching ACP', async () => {
    const definitions: Definition[] = []
    let reads = 0
    let writes = 0
    const ctx = {
      tools: {
        register(definition: Definition) {
          definitions.push(definition)
          return () => undefined
        },
      },
    } as never
    const connection = {
      async createTerminal() {
        throw new Error('unexpected terminal')
      },
      async readTextFile() {
        reads += 1
        return { content: '' }
      },
      async writeTextFile() {
        writes += 1
      },
    } as never
    installNativeSolveTools(ctx, {
      connection,
      sessionId: 'session-1',
      cwd: '/workspace',
    })
    const controller = new AbortController()
    controller.abort()
    const read = definitions.find((definition) => definition.name === 'solve_read')
    const write = definitions.find((definition) => definition.name === 'solve_write')
    await expect(
      read!.execute({ path: '/workspace/a' }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted before file read/)
    await expect(
      write!.execute({ path: '/workspace/a', content: 'x' }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted before file write/)
    expect(reads).toBe(0)
    expect(writes).toBe(0)
  })

  it('emits only a bounded, content-free solve observation to the trusted caller', async () => {
    const definitions: Definition[] = []
    const observed: Array<{ type: string; value?: unknown }> = []
    const ctx = {
      tools: {
        register(definition: Definition) {
          definitions.push(definition)
          return () => undefined
        },
      },
    } as never
    const terminal = {
      async waitForExit() {
        return { exitCode: 0 }
      },
      async currentOutput() {
        return { output: '' }
      },
      async release() {},
    }
    const connection = {
      async createTerminal() {
        return terminal
      },
      async readTextFile() {
        return { content: 'untrusted file content' }
      },
      async writeTextFile() {},
    } as never
    installNativeSolveTools(ctx, {
      connection,
      sessionId: 'session-1',
      cwd: '/workspace',
      observation: {
        execStarted(input) {
          observed.push({ type: 'execStarted', value: input })
        },
        execFinished(outcome) {
          observed.push({ type: 'execFinished', value: outcome })
        },
        readCompleted() {
          observed.push({ type: 'readCompleted' })
        },
        writeCompleted() {
          observed.push({ type: 'writeCompleted' })
        },
      },
    })
    await definitions
      .find((definition) => definition.name === 'solve_write')!
      .execute({
        path: '/workspace/a',
        content: 'secret content',
      })
    await definitions
      .find((definition) => definition.name === 'solve_exec')!
      .execute({
        command: 'printf',
        args: ['secret output'],
      })
    await definitions
      .find((definition) => definition.name === 'solve_read')!
      .execute({
        path: '/workspace/a',
      })
    expect(observed).toEqual([
      { type: 'writeCompleted' },
      { type: 'execStarted', value: { command: 'printf', args: ['secret output'] } },
      { type: 'execFinished', value: 'empty-output' },
      { type: 'readCompleted' },
    ])
  })
})
