/** One child, one fresh validator. No model socket or candidate-controlled build script. */
import { readFile, writeFile } from 'node:fs/promises'
import { buildCandidate } from '../builder/pipeline.js'
import { assertExact, ExecutionError } from '../execution/types.js'
async function main() {
  if (process.getuid?.() === 0 || process.argv[2] !== '/input/config.json')
    throw new ExecutionError('validator requires non-root and fixed config')
  const value: unknown = JSON.parse(await readFile('/input/config.json', 'utf8'))
  assertExact(
    value,
    ['protocol', 'sourceDigest', 'dependencyClosureSha256'],
    ['treeV2ParentEvidence'],
  )
  if (
    value.protocol !== 'dsh-evolve-le/validator/v1' ||
    typeof value.sourceDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.sourceDigest) ||
    typeof value.dependencyClosureSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.dependencyClosureSha256)
  )
    throw new ExecutionError('invalid validator config')
  const result = await buildCandidate({
    sourceDir: '/input/source',
    parentTreeDir: '/input/parent',
    workRoot: '/workspace/build',
    dependencyCapsuleDir: '/input/capsule',
    expectedDependencyClosureSha256: value.dependencyClosureSha256,
    ...(value.treeV2ParentEvidence === undefined
      ? {}
      : {
          treeV2ParentEvidence: value.treeV2ParentEvidence as NonNullable<
            Parameters<typeof buildCandidate>[0]['treeV2ParentEvidence']
          >,
        }),
  })
  if (result.sourceDigest !== value.sourceDigest)
    throw new ExecutionError('validator source identity mismatch')
  await writeFile(
    '/work/validator-result.json',
    JSON.stringify({
      protocol: 'dsh-evolve-le/validator-result/v1',
      sourceDigest: value.sourceDigest,
      result,
    }) + '\n',
    { flag: 'wx' },
  )
  if (result.outcome !== 'admitted') process.exitCode = 1
}
main().catch(async (error) => {
  const message = error instanceof Error ? error.message : 'validator failed'
  await writeFile('/work/validator-failure.json', JSON.stringify({ error: message }) + '\n').catch(
    () => undefined,
  )
  process.stderr.write(message + '\n')
  process.exitCode = 1
})
