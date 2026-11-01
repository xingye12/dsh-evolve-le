/** Trusted Docker proposal overlay; writable Cordis config stays outside capsule. */
import { bootConfig } from '../builder/capsule.js'
import { ExecutionError } from './types.js'
export function dockerProposalComposition(options: {
  candidatePackage: string
  candidateId: string
  executionId: string
  socketPath: string
  shellTimeoutMs: number
  outputBytes: number
}): string {
  if (
    !/^@[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(options.candidatePackage) ||
    !/^[a-zA-Z0-9:_-]+$/.test(options.candidateId) ||
    !/^[a-zA-Z0-9_.-]+$/.test(options.executionId) ||
    options.socketPath !== '/gateway/action.sock' ||
    !Number.isSafeInteger(options.shellTimeoutMs) ||
    options.shellTimeoutMs <= 0 ||
    !Number.isSafeInteger(options.outputBytes) ||
    options.outputBytes <= 0
  )
    throw new ExecutionError('invalid frozen Docker composition')
  const base = bootConfig(options.candidatePackage, options.candidateId, 'propose', {
    dshHome: '/work/home',
  }).replaceAll("name: './runtime/", "name: '/input/capsule/runtime/")
  return (
    base +
    [
      '- id: proposal-container-shell',
      "  name: '/input/capsule/runner/dsh/container-shell-plugin.js'",
      '  config:',
      `    socketPath: ${options.socketPath}`,
      `    executionId: ${options.executionId}`,
      `    timeoutMs: ${options.shellTimeoutMs}`,
      `    outputBytes: ${options.outputBytes}`,
      '- id: proposal-shell-env',
      "  name: '@deepseek-ai/dsh-shell-env'",
      '  config:',
      '    dshHome: /work/home',
      '- id: proposal-tool-bash',
      "  name: '@deepseek-ai/dsh-tool-bash'",
      '  config:',
      '    enableRunInBackground: false',
      '',
    ].join('\n')
  )
}
