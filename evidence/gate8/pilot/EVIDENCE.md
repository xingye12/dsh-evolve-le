# Gate 8 pilot evidence — what this subset contains

This directory is a **subset copy** of the live run root, written only on PASS
by `scripts/record-gate8-pilot.ts`. The live root (`dsh-gate8-pilot-DCJKdk`)
was deleted by the recorder after the copy (scratch cleanup), so this subset is
the durable record. Know its boundaries before auditing:

## Contents

- `pilot-run.json` — machine-checkable facts (37 assertions), proposal
  receipts, lineage, participation, budget actuals. `evidenceSha256` in
  `STATUS.json` is the sha256 of this file.
- `run/` — controller state (`controller/` journal + snapshots), frozen
  ceremony/split/pool/manifest documents, harbor ledger, `objects/`
  (content-addressed candidate sources and trajectories), `exports/`,
  `harbor-plans/`, and `capsules/<candidateId>.json` records.
- `jobs/` — the raw Harbor job directories (per-trial `result.json`,
  `config.json`, `agent/`, `verifier/`, logs) for all 50 trials.

## Solve-side model: recorded replay, not the live route

All 50 solve trials (baseline freeze, pool, and q0 cold-starts — every
candidate including the baseline) ran the Gate 6 stable-demo capsule whose
LLM surface is a **deterministic recorded-replay**. For prompts with no
matching recording the agent replies
`[dsh-evolve-le replay] no recorded response for prompt sha256:…` and ends
the turn: two trajectory steps, zero tool calls, zero work product. The
verifiers ran for real against that empty workspace, so every reward is a
genuine verifier outcome of a zero-capability agent — not an infra
masquerade (all 50 trials participation `ran`, ADR-025). The live
`deepseek-v4-flash` route was used only on the propose side (4 expansions).
Reading a solve reward from this run as a capability number for any model
or harness is invalid by construction.

Per-task verifier shapes for the 6 discovery (baseline freeze) trials:
`adaptive-rejection-sampler` 9/9 tests failed (no `/app/ars.R`, no
`Rscript`); `build-pmars` 4/4 failed; `circuit-fibsqrt` 2 passed / 1 failed
(trivially-satisfiable checks pass); `bn-fit-modify`, `caffe-cifar-10`,
`chess-best-move` — the verifier's own uv-bootstrap could not download
(`network` restricted in the verify stage), normalized to reward 0 per
rule 7; the agent did no work in these trials regardless.

## Known subset semantics (not tampering)

`capsules/` here carries the per-candidate records (including
`archiveSha256`) but **not** the 13 `<sha256>.tar.gz` capsule archives: each
archive bundles the pinned node runtime (~130 MB each; ~1.7 GB total), which
is out of proportion to the rest of the evidence. Consequences:

- Re-running `dsh-evolve audit` **over this subset** reports
  `capsule-archives: archive missing` for every record. The PASS-time audit
  ran over the live run root and verified all 13 archives
  (`gate8-pilot9.log`, `capsule-archives: 13 archive(s) verified`).
- An archive is re-derivable: capsules are content-addressed builds of the
  archived candidate source (`run/objects/`) plus the pinned runtime recorded
  in the manifest; the expected digest is pinned in each
  `capsules/<candidateId>.json` record. A rebuild that does not reproduce
  `archiveSha256` is a real defect; a missing file alone is this subset's
  designed state.
