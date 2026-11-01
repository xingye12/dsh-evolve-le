/** Read-only preflight; no model, container creation or daemon changes. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { localDockerEngine } from '../packages/dsh-evolve-le/src/execution/docker-engine.js'
import { doctorDockerSandbox } from '../packages/dsh-evolve-le/src/execution/doctor.js'
const report = await doctorDockerSandbox(localDockerEngine())
const destination = process.argv[2]
if (destination) {
  const path = resolve(destination)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exitCode = report.ready ? 0 : 1
