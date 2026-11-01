import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { claimOwnerGeneration, reclaimActionEndpoint } from '../../lib/execution/owner.js'
const owner = await claimOwnerGeneration(process.argv[2], 'a'.repeat(64))
await mkdir(join(process.argv[2], 'ipc'), { recursive: true, mode: 0o755 })
await reclaimActionEndpoint(process.argv[2], owner)
const server = createServer((socket) => socket.destroy())
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(join(process.argv[2], 'ipc/action.sock'), resolve)
})
process.stdout.write(JSON.stringify(owner) + '\n')
setInterval(() => {}, 1000)
