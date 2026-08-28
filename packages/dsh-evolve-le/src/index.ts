/**
 * Trusted Cordis controller surface for dsh-evolve-le. Gate 0 exports the
 * real-Loader boot and lifecycle inventory used by the loader spike, the E2E
 * suites, and later gates' controller service.
 * @module @dsh-evolve-le/core
 */

export {
  bootLoader,
  LoaderActivationError,
  type BootLoaderOptions,
  type BootedLoader,
  type EntryActivationFailure,
} from './cordis/boot.js'
export {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type EffectRecord,
  type FiberRecord,
  type ListenerRecord,
  type ProcessHandleInventory,
  type RuntimeRecord,
  type ServiceRecord,
} from './cordis/inventory.js'
export {
  buildCandidate,
  STAGE_ORDER,
  type BuildInput,
  type BuildResult,
  type Receipt,
  type Receipts,
  type ReceiptStatus,
  type StageName,
} from './builder/pipeline.js'
