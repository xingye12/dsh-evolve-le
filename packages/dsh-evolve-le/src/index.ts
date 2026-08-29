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
export {
  ACP_ENTRYPOINT_NAME,
  archiveCapsule,
  CAPSULE_PROTOCOL,
  type CapsuleBundle,
} from './builder/capsule.js'
export {
  promptSha256,
  replayKey,
  replayResponseFor,
  type RecordedTurn,
} from './acp/recorded-replay.js'
export { computeTreeDigest, TREE_DIGEST_ALGO } from './digest.js'
export {
  Controller,
  ControllerError,
  readRunStatus,
  TRAJECTORY_MEDIA_TYPE,
  type BoundaryPoint,
  type ControllerConfig,
  type EvaluationInput,
  type EvaluationRequest,
  type RecoveryDisposition,
  type RecoveryReport,
  type RunStatus,
} from './controller/controller.js'
export {
  acquireWriterLock,
  LockError,
  LOCK_FILE,
  type AcquireOptions,
  type OwnerRecord,
} from './controller/lock.js'
export {
  FakeProvider,
  type BenchmarkProvider,
  type ProviderCounters,
  type ProviderInspect,
  type ProviderJobStatus,
  type ProviderTerminal,
  type ScriptedResult,
} from './controller/provider.js'
export { FileProvider } from './controller/file-provider.js'
export {
  runFaultMatrix,
  MATRIX_BOUNDARIES,
  type MatrixCase,
  type MatrixResult,
} from './controller/fault-matrix.js'
export {
  betaParametersFor,
  cladeMembers,
  cladeStats,
  CMP_PRECISION,
  nodeStats,
  type CladeEntry,
  type CladeInput,
  type NodeStats,
} from './selection/clade.js'
export {
  betaSample,
  drawNodeThompson,
  drawParentThompson,
  DEFAULT_TAU,
  type DrawParameters,
  type ThompsonDraw,
} from './selection/thompson.js'
export { shouldExpand, UCB_AIR_ALPHA, type UcbAirInput } from './selection/ucbair.js'
export type { Observation, ObservationOutcome } from './state/reducer.js'
export { canonicalHash, canonicalJson, CanonicalJsonError } from './state/canonical.js'
export {
  runSplitCeremony,
  SPLIT_COUNTS,
  SPLIT_PROTOCOL,
  type SealedSplitStore,
  type SplitCeremony,
  type SplitCeremonyInput,
} from './split/ceremony.js'
export {
  defaultRunConfig,
  loadRunConfig,
  RUN_CONFIG_SCHEMA_ID,
  RunConfigError,
  STABLE_DEMO_DEFAULTS,
  validateRunConfig,
  type ModelRouteConfig,
  type RunConfig,
  type RunConfigErrorReport,
  type RunConfigResult,
} from './config/run-config.js'
export {
  ITERATION_PROTOCOL,
  SEARCH_STATE_PROTOCOL,
  FAILURE_POOL_PROTOCOL,
  IterationDriver,
  IterationDriverError,
  type BuildCapsuleFn,
  type BuiltCapsule,
  type DriveReport,
  type IterationDriverInput,
  type ProviderBridge,
  type StopReason,
} from './iteration/driver.js'
export {
  assertPreflight,
  baselineSourceCheck,
  configCheck,
  credentialChecks,
  dockerCheck,
  harborVersionCheck,
  PreflightError,
  runPreflight,
  runRootCheck,
  tasksRootCheck,
  type PreflightCheck,
  type PreflightFinding,
} from './iteration/preflight.js'
export type {
  Config as ControllerServiceConfig,
  DshEvolveControllerService,
} from './service/controller-service.js'
