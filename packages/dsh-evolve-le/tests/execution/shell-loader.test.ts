import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { openActionRpc } from '../../src/execution/rpc.js'
const exec = promisify(execFile)
const closure = process.env.DSH_DOCKER_NATIVE_CLOSURE ?? '/tmp/dsh-docker-native-closure'
const enabled = existsSync(join(closure, 'node_modules/@deepseek-ai/dsh-shell/package.json'))
describe.skipIf(!enabled)('container shell through real Cordis Loader', () => {
  it('discovers standard bash, delegates foreground calls and rejects escalation/background; unloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-shell-loader-'))
    const socketPath = join(root, 'action.sock')
    let calls = 0
    const server = await openActionRpc({
      socketPath,
      executionId: 'execution',
      socketUid: process.getuid!(),
      socketGid: process.getgid!(),
      maxFrameBytes: 1048576,
      maxConnections: 4,
      async handler(request) {
        expect(request.method).toBe('shell')
        expect(request.args).toMatchObject({
          command: 'echo shared',
          cwd: '/workspace',
          timeoutMs: 1000,
          dshEnv: { DSH_HOME: '/work/home', DSH_SHELL: '1' },
        })
        calls++
        return { exitCode: 0, stdout: 'shared\n', stderr: '', receiptDigest: 'a'.repeat(64) }
      },
    })
    try {
      await symlink(join(closure, 'node_modules'), join(root, 'node_modules'))
      await cp(resolve('packages/dsh-evolve-le/lib'), join(root, 'runner'), { recursive: true })
      await writeFile(
        join(root, 'cordis.yml'),
        `- id: spine\n  name: '@deepseek-ai/dsh-agent-spine-demo'\n  config:\n    dshHome: '${root}/home'\n    workspaceContext: false\n    includeRuntimeContext: false\n    skills:\n      enabled: false\n    goals: false\n    toolBash: false\n    toolJobs: false\n- id: shell\n  name: './runner/dsh/container-shell-plugin.js'\n  config:\n    socketPath: '${socketPath}'\n    executionId: execution\n    timeoutMs: 1000\n    outputBytes: 1048576\n- id: shell-env\n  name: '@deepseek-ai/dsh-shell-env'\n  config:\n    dshHome: '/work/home'\n- id: bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  config:\n    enableRunInBackground: false\n`,
      )
      await cp(
        resolve('packages/dsh-evolve-le/tests/fixtures/container-shell-loader.mjs'),
        join(root, 'check.mjs'),
      )
      const result = await exec(process.execPath, [join(root, 'check.mjs')], {
        timeout: 30000,
        maxBuffer: 1048576,
      })
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({
        bash: true,
        foreground: true,
        backgroundDenied: true,
        escalationDenied: true,
        nativeAgentLoop: true,
        quiescent: true,
      })
      expect(calls).toBe(2)
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
