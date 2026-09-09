/**
 * @dsh-evolve-le/tb-provider — the Terminal-Bench 2.1 Harbor benchmark
 * adapter (Gate 2, specs/04). Pure TypeScript planning + normalization over
 * the pinned upstream task set; no RSI policy lives here (CLAUDE.md rule 2),
 * and no sealed-set result ever flows back in (rule 5).
 * @module @dsh-evolve-le/tb-provider
 */

export { DATASET_PIN, type DatasetPin } from './dataset.js'
export {
  INVENTORY_PROTOCOL,
  buildTaskInventory,
  parseTaskName,
  selectTasks,
  type InventoryTask,
  type TaskInventory,
} from './inventory.js'
export {
  ACP_AGENT_ID,
  ACP_CMD,
  buildAcpRegistryEntry,
  type AcpRegistryEntry,
  type RegistryEntryInput,
} from './registry.js'
export { PROVIDER_PROTOCOL, buildJobConfig, type JobPlan, type JobPlanInput } from './jobconfig.js'
export {
  LEDGER_PROTOCOL,
  SubmissionLedger,
  idempotencyKey,
  jobNameForKey,
  type IdempotencyInputs,
  type LedgerEntry,
} from './idempotency.js'
export {
  planSubmission,
  type PerJobOverlay,
  type PlanSubmissionInput,
  type SubmissionPlan,
} from './provider.js'
export {
  INFRA_RETRYABLE_EXCEPTIONS,
  RUN_PROTOCOL,
  TRIAL_PROTOCOL,
  canonicalJson,
  normalizeJob,
  sha256Hex,
  type NormalizedTrial,
  type OutcomeCategory,
  type RunArtifact,
  type TrialIdentity,
  type TrialStatus,
} from './normalize.js'
export {
  DIAGNOSTIC_TRACE_BUNDLE_PROTOCOL,
  diagnosticTraceBundle,
  type DiagnosticTraceBundle,
} from './diagnostic-bundle.js'
export {
  buildAugmentedCaBundle,
  generateLocalCa,
  startArtifactServer,
  type ArtifactServer,
  type LocalCa,
} from './artifact-server.js'
export {
  HarborProvider,
  HarborProviderError,
  TERMINAL_FACT_PROTOCOL,
  type HarborEvaluationRequest,
  type HarborProviderConfig,
  type HarborSolveGateway,
  type RegisteredCapsule,
  type SolverFactBlock,
} from './harbor-provider.js'
export {
  IMAGE_PREFETCH_PROTOCOL,
  parseDockerImage,
  prefetchTaskImages,
  taskImageRefs,
  type ImageCommandRunner,
  type ImagePrefetchReceipt,
  type ImagePrefetchRecord,
} from './image-cache.js'
export {
  ACP_RUNTIME_PACKAGE,
  ACP_RUNTIME_VENV_PATH,
  VERIFIER_IMAGE_PROTOCOL,
  prepareOfflineVerifierTasks,
  rewriteVerifierOffline,
  rewriteVerifierGitClones,
  verifierRequirements,
  verifierSystemRequirements,
  type VerifierImageCommandRunner,
  type VerifierGitSource,
  type VerifierImageReceipt,
  type VerifierImageRecord,
} from './verifier-image.js'
export {
  effectiveTaskAgentTimeoutMs,
  parseTaskAgentTimeoutSec,
  taskAgentTimeoutSec,
  SOLVE_AGENT_TIMEOUT_ENV,
} from './task-timeout.js'
