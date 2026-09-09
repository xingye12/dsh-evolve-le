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
  type TreeV2BuildReceipts,
} from './builder/pipeline.js'
export {
  ACP_ENTRYPOINT_NAME,
  archiveCapsule,
  CAPSULE_PROTOCOL,
  NATIVE_DSH_COMPOSITION_PROTOCOL,
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
  ATTRIBUTION_RECEIPT_MEDIA_TYPE,
  ATTRIBUTION_RESULT_MEDIA_TYPE,
  DIAGNOSTIC_TRACE_MEDIA_TYPE,
  readRunStatus,
  TRAJECTORY_MEDIA_TYPE,
  type BoundaryPoint,
  type ControllerConfig,
  type EvaluationInput,
  type AttributionInput,
  type AttributionResult,
  type EvaluationRequest,
  type ProposalRunner,
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
  TREE_V2_PROTOCOL,
  TREE_V2_RECEIPT_KINDS,
  assertModeContract,
  assertRequiredParentEvidence,
  assertTreeV2CandidateTree,
  assertTreeV2Child,
  assertTreeV2RuntimeModeContract,
  finalizeTreeV2Receipt,
  treeV2Digest,
  treeV2RuntimeFingerprint,
  verifyTreeV2Receipt,
  type TreeV2CandidateIntent,
  type TreeV2Mode,
  type TreeV2ModeContract,
  type TreeV2Receipt,
  type TreeV2ReceiptKind,
  type TreeV2RequiredParentEvidence,
} from './tree-v2/contract.js'
export {
  TREE_V2_MEDIA_TYPES,
  assertTreeV2ReceiptChain,
  assertTreeV2ReceiptDocument,
  persistTreeV2ReceiptDocument,
  type TreeV2AdmissionReceipt,
  type TreeV2AnalysisReceipt,
  type TreeV2CapabilityCatalogReceipt,
  type TreeV2MaterializationReceipt,
  type TreeV2MechanismOutcomeReceipt,
  type TreeV2ProposalReceipt,
  type TreeV2ReceiptChain,
} from './tree-v2/receipts.js'
export {
  assertTreeV2MigrationReceipt,
  createTreeV2MigrationReceipt,
  persistTreeV2MigrationReceipt,
  type TreeV2MigrationInput,
} from './tree-v2/migration.js'
export {
  finalizeTreeV2Bundle,
  TreeV2FinalizationError,
  type FinalizeTreeV2BundleOptions,
} from './tree-v2/finalize-bundle.js'
export { validateTreeV2, type TreeV2SchemaKind } from './schema.js'
export {
  runSplitCeremony,
  SPLIT_COUNTS,
  splitCountsForPopulation,
  SPLIT_PROTOCOL,
  type SealedSplitStore,
  type SplitCounts,
  type SplitCeremony,
  type SplitCeremonyInput,
} from './split/ceremony.js'
export {
  defaultRunConfig,
  loadRunConfig,
  RUN_CONFIG_SCHEMA_ID,
  TERMINAL_BENCH_MAX_AGENT_TIMEOUT_SEC,
  RunConfigError,
  STABLE_DEMO_DEFAULTS,
  validateRunConfig,
  type ModelRouteConfig,
  type NativeDshRuntimeConfig,
  type RunConfig,
  type RunConfigErrorReport,
  type RunConfigResult,
} from './config/run-config.js'
export {
  remoteProposalRunner,
  remoteRoutePlanOf,
  solverRoutePlan,
  REMOTE_PROPOSER_BUDGET,
  LIVE_ROUTE_REQUEST_TIMEOUT_MS,
} from './proposer/remote-runner.js'
export {
  openRemoteModelProxy,
  remoteRoutePlanHash,
  verifyRemoteReceipts,
  type RemoteProxy,
  type RemoteReceipt,
  type RemoteReceiptOk,
  type RemoteReceiptError,
  type RemoteReceiptVerification,
  type RemoteRoutePlan,
} from './proposer/remote-gateway.js'
export { upstreamChatCompletion } from './proposer/upstream.js'
export {
  AGENT_DEBUGGER_PROTOCOL,
  FAILURE_ATTRIBUTION_MEDIA_TYPE,
  AgentDebuggerError,
  remoteAgentDebugger,
  selectDebuggerTraces,
  type DebuggerTraceInput,
  type FailureAttributionResult,
  type FailureAttributor,
  type DurableFailureAttributor,
  type AttributionAttempt,
  type AttributionUsageReceipt,
  type FailureMode,
} from './attribution/agent-debugger.js'
export {
  DEFAULT_SOLVE_TRIAL_BUDGET,
  openSolveGateway,
  SOLVE_GATEWAY_PATH,
  type SolveGateway,
} from './solver/gateway.js'
export {
  verifySolveReceipts,
  type SolveReceipt,
  type SolveReceiptError,
  type SolveReceiptOk,
  type SolveReceiptVerification,
} from './solver/receipts.js'
export {
  liveSolveLimitsFromAgentTimeout,
  SOLVE_AGENT_LIMITS,
  SOLVE_AGENT_TIMEOUT_ENV,
  SOLVE_HARBOR_TEARDOWN_RESERVE_MS,
  solverTrackOf,
} from './config/run-config.js'
// The controller derives the solve gateway's ADR-033 retry budget from the
// in-container client's fixed per-request timeout (minus margin), so the two
// sides of the wire stay coupled by one constant.
export { SOLVE_CLIENT_REQUEST_TIMEOUT_MS } from './acp/solve-client.js'
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
  dockerNetworkCapacityCheck,
  type DockerNetworkCommandRunner,
  harborVersionCheck,
  nativeDshCatalogCheck,
  proposalWorkerIdentityCheck,
  PreflightError,
  runPreflight,
  runRootCheck,
  searchCalibrationCheck,
  tasksRootCheck,
  type PreflightCheck,
  type PreflightFinding,
} from './iteration/preflight.js'
export {
  inspectNativeDshRuntime,
  openNativeDshCatalog,
  type NativeDshCatalog,
  type NativeDshRuntimeLock,
} from './builder/staging.js'
export type {
  Config as ControllerServiceConfig,
  DshEvolveControllerService,
} from './service/controller-service.js'
export {
  createNativeDshAgent,
  candidateStrategySetupOf,
  hasNativeDshComposition,
  mountNativeDshComposition,
  nativeAssistantText,
  nativeUserMessage,
  installNativePromptSections,
  NativeDshUnavailableError,
  NATIVE_DSH_PACKAGE_PINS,
  assertNativeDshClosure,
  nativeDshClosurePresent,
  NATIVE_DSH_PROTOCOL,
  type NativeDshAgent,
  type NativeDshAgentOptions,
  type NativeDshCancelCause,
  type NativeDshPackage,
  type NativeDshMode,
  type NativeDshCompositionOptions,
  type CandidateStrategySetup,
  type NativePromptSection,
} from './dsh/native-composition.js'
export {
  runNativeDshTurn,
  type NativeDshTurnInput,
  type NativeDshTurnResult,
} from './dsh/native-runner.js'
export {
  installNativeProposalTools,
  disposeNativeProposalTools,
  type NativeProposalToolBackend,
  type NativeProposalToolState,
} from './dsh/native-proposal.js'
export {
  runNativeProposal,
  NativeProposalError,
  NATIVE_PROPOSAL_PROTOCOL,
  type NativeProposalRunOptions,
  type NativeProposalRunResult,
} from './dsh/native-proposal-runner.js'
export {
  installNativeLlmAdapter,
  type NativeLlmAdapterOptions,
  type NativeLlmCompletionRequest,
  type NativeLlmCompletionResult,
  type NativeLlmToolSchema,
} from './dsh/native-llm-adapter.js'
export {
  createNativeSolveAgent,
  NATIVE_SOLVE_POLICY_SECTION,
  type NativeSolveAgentOptions,
  type NativeSolveSession,
} from './acp/native-solve-agent.js'
export { installNativeSolveTools } from './acp/native-solve-tools.js'
export {
  generateSealedPlan,
  validateSealedPlan,
  verifySealedPlanDraws,
  SEALED_ANALYSIS_DEFAULTS,
  SEALED_PLAN_PROTOCOL,
  type SealedAnalysis,
  type SealedBudget,
  type SealedPlanDoc,
  type SealedPlanInput,
  type SealedTrialCell,
} from './sealed/plan.js'
export {
  sealedEvaluate,
  scoreSealed,
  verdictSealed,
  SEALED_DELTA_GATE,
  SEALED_RESULTS_PROTOCOL,
  SEALED_VERDICT_PROTOCOL,
  type SealedEvaluateInput,
  type SealedEvaluateResult,
  type SealedResultsDoc,
  type SealedScore,
  type SealedTrialOutcome,
  type SealedTrialRow,
  type SealedVerdict,
} from './sealed/evaluate.js'
