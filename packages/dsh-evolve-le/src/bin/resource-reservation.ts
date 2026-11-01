import { runResourceReservationRequest } from '../execution/reservation-ledger.js'
try {
  const admitted = await runResourceReservationRequest(process.argv[2] ?? '')
  process.stdout.write(JSON.stringify({ admitted }) + '\n')
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : 'resource transaction failed') + '\n',
  )
  process.exitCode = 1
}
