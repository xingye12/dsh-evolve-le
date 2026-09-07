# dsh-evolve-le tree-v2 implementation specification

**Protocol:** `dsh-self-evolving-candidate-tree-v2`  
**Schema version:** `2`  
**Status:** normative implementation boundary; it does not assert benchmark improvement.

## Purpose

The legacy `dsh-evolve-le` candidate is a single declarative file. tree-v2 is the
migration target for harness-level evolution: one candidate is a content-addressed,
multi-file Cordis component with candidate-owned tests, a typed capability catalog,
and independently verifiable receipts for each proposal step.

The v1 protocol remains readable and evaluable during migration. A v1 document is
never upgraded by changing a version field, and a v1 score is never copied to a
tree-v2 node.

## Candidate tree

The canonical source allowlist is:

```text
candidate.json  package.json  cordis.patch.yml  tsconfig.json  README.md
src/**/*.ts     tests/**/*.spec.ts     fixtures/**/*.json
```

The trusted capture still enforces the existing 25-file, 1 MiB and 5,000 changed
line caps. A tree-v2 candidate additionally MUST contain `src/index.ts`, at least
one other production module, and at least one candidate-owned test. The root MUST
mount the component with `ctx.plugin(...)`; a test-only or manifest-only child is
rejected. `runtime.modeComponents.solve` and `.propose` name the exact production
files used to implement each mode. Those paths must exist in the captured tree.
`runtime.modeSurfaces.solve` and `.propose` separately declare the names exposed
on all six runtime surfaces. `runtime.capabilities` is an inventory, not an
independent claim: it MUST equal the exact union of the non-empty mode surface
declarations, with no duplicate, omitted, or unused capability.

The component package is installed only in the one-shot capsule. It cannot alter
the model adapter, verifier, dataset/split/scorer, controller, budget, sandbox
policy, or credential services. Candidate effects are owned by the candidate Fiber
and must be removed when that Fiber unloads.

## Executable strategy surfaces

`defineCandidate()` supports all six registered strategy surfaces:

| Manifest surface | SDK registration | Runtime ownership                                 |
| ---------------- | ---------------- | ------------------------------------------------- |
| `system-prompt`  | `promptSection`  | `ctx.systemPrompt.section()`                      |
| `tools`          | `tools`          | `ctx.tools.register()`                            |
| `skills`         | `skills`         | `ctx.skills.register()`                           |
| `agent-events`   | `agentEvents`    | effect-owned `ctx.on('candidate:agent/*', ...)`   |
| `session-events` | `sessionEvents`  | effect-owned `ctx.on('candidate:session/*', ...)` |
| `workflow`       | `workflows`      | trusted `candidateWorkflows.register()`           |

Names, counts, descriptions, content and handlers are bounded by the SDK. Event
names are candidate-prefixed and workflows are registered through a TCB-provided
registry; candidates do not create arbitrary host services. Loader probes record
all six surfaces for each mode before and after unload, and the builder compares
those records with that mode's manifest declaration.

## Mode contract

Every tree-v2 candidate declares a disjoint partition:

```json
{ "targetModes": ["solve"], "preservedModes": ["propose"] }
```

The static gate computes a content projection from the declared production files.
Every preserved projection MUST be byte-identical to the parent. Every target
projection MUST differ, and the child MUST modify `src/index.ts`, add a production
module, and add a test. The isolated real Loader then computes a runtime fingerprint
for both modes. Preserved fingerprints MUST equal the trusted parent admission
record; target fingerprints MUST differ. A missing parent fingerprint is a hard
failure, not an invitation to infer one.

The candidate's mechanism and preservation tests run in the trusted builder before
the Loader probes. Runtime fingerprints are evidence of the actual mounted
component, not a substitute for those tests.

`candidate.json` is itself the `candidate-intent` receipt. It therefore carries
`kind: "candidate-intent"` and `receiptDigest`; changing the mode contract,
parent evidence, runtime catalog or test declaration invalidates that digest.

## Named parent evidence

`requiredParentEvidence` has exactly four semantic bindings:

```json
{
  "analysisDigest": "sha256:<64 hex>",
  "mechanismOutcomeDigest": "sha256:<64 hex>",
  "normalizedTrialDigest": "sha256:<64 hex>",
  "trajectoryDigest": "sha256:<64 hex>"
}
```

The builder compares this object to the trusted parent admission record. Bare
unordered evidence lists are valid only for v1 and cannot satisfy tree-v2.
Normalized trial documents are canonical JSON objects stored as `DEV_OBSERVED`
artifacts beside raw trajectories, so the controller can resolve both named
digests back to bytes.

## Proposal envelope

The sandbox wire protocol is explicitly dual-versioned. A legacy
`dsh-evolve-le/proposal/v1` child carries bare `evidenceRefs` and may materialize
only a v1 candidate. A `dsh-evolve-le/proposal/v2` child MUST omit that field and
carry an `analysis` receipt plus a `proposal` receipt. The controller verifies
their canonical digests, ensures the named normalized-trial and trajectory
digests occur in the exported evidence view, then re-captures the child and binds
both receipts to its `candidate-intent`. Crossing v1/v2 envelope and candidate
versions is rejected.

Protocol selection is bound to the admitted parent, not left to the proposer.
Legacy parents retain v1 output for replay compatibility. Once a parent has a
tree-v2 admission record, its durable proposal request carries the parent
candidate and mechanism-outcome digests; the sandbox, recorded proposer and
remote prompt then default to v2 and the controller rejects v1 output. This is
dual-read/version-preserving-write migration, not an in-place version-field
upgrade.

## Receipt chain

The following documents use the tree-v2 protocol and are independently validated
by strict draft-2020-12 JSON Schema:

1. `proposal`
2. `analysis`
3. `candidate-intent`
4. `mechanism-outcome`
5. `capability-catalog`
6. `materialization-receipt`
7. `admission-receipt`
8. `migration-receipt`

Every receipt is canonical JSON and carries `receiptDigest`, computed as
`sha256(canonicalJson(receiptWithoutReceiptDigest))`. A receipt is accepted only
when its protocol, kind, schema and digest all verify. The build manifest keeps the
legacy ten stage receipts for compatibility and adds the tree-v2 mode/evidence
record when the candidate follows this protocol.

The trusted builder issues the `mechanism-outcome`, `capability-catalog`,
`materialization-receipt`, and `admission-receipt` documents after their
corresponding gates pass and writes them under `tree-v2-receipts/`. Capsule
records retain content-addressed object refs for those documents plus the parent
Loader fingerprints and mechanism/admission receipt digests, allowing the next
rebuild to validate its parent without trusting the proposer. The controller
also publishes every validated analysis, proposal and admitted candidate-intent
as a separate object-store artifact. The seven-document proposal-to-admission
chain has a separate cross-reference validator; migration receipts are
independent chain roots and have an object-store persistence API.

The receipt chain is append-only evidence. It does not make an admission result a
performance result: archive admission, development champion, sealed promotion and
full-set leaderboard remain distinct states.

## v1 migration

`createTreeV2MigrationReceipt()` records the old and new candidate/source digests
and sets `resultsInherited: false`. The required actions are exactly `rebuild`,
`readmit`, and `reevaluate`. Historical v1 artifacts may be retained for audit and
diagnosis, but they do not contribute trials, scores, champion status, or sealed
promotion for the tree-v2 identity.

## Acceptance gates

- Schema gate: all tree-v2 documents validate with strict Ajv and all receipts have
  a matching canonical digest.
- Tree gate: source allowlist, root plugin, production/test presence and declared
  mode component paths pass.
- Diff gate: parent digest, named evidence, static mode contract and required
  production/test changes pass.
- Runtime gate: the real Cordis Loader boots both modes, all declared surfaces are
  present, target/preserved runtime fingerprints satisfy the contract, and unload
  returns inventory and process handles to baseline.
- Migration gate: no v1 result is inherited; the new candidate follows the same
  build, admission and evaluation path.

These gates are implemented and unit-tested in the trusted core. No sealed result,
cost target, +5 percentage-point claim or SOTA claim is implied without the
corresponding frozen Terminal-Bench evidence.
