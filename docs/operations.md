# Operations: stop, resume, restore, rollback and uninstall

Every procedure below is executed (not merely documented) by `scripts/verify-fresh-install.ts`
(`pnpm install:verify`) on a fresh profile; that script is the runnable specification of this page.

## Stop

Interrupt the CLI (Ctrl-C / SIGTERM). The controller writes observations append-only, so a stop at
any point leaves a consistent prefix; Harbor children finish or are re-attributed per the
fail-closed normalizer. Never delete state to "reset" a run — use `resume`.

## Resume

```bash
node packages/cli/lib/main.js resume --run-root runs/<run-id>
```

`resume` replays the journal from the latest valid snapshot, re-evaluates stop semantics and
continues. It is idempotent with `run`: completed observations are never re-spent. If the run
already reached a terminal state, `resume` re-derives `drive-report.json` and exits without
re-running anything.

## Prior-state restore (executed drill)

To restore the state that existed at an earlier point — or to recover after losing every snapshot:

1. Snapshots are checkpoints; the journal is the truth. Fold the journal prefix up to `seq` N with
   the shipped reducer (`packages/dsh-evolve-le/src/state/`) and compare `stateHash` against
   `controller/snapshots/state-<N>-<hash>.json` — they must match exactly.
2. If **all** snapshots and `drive-report.json` are deleted, `status` reconstructs the terminal
   `stateHash` and observation count from the journal alone; one `resume` re-derives the report.
3. The journal must be byte-identical before and after any restore, and `audit` must stay green.

The drill is asserted as checks `priorStateRestoredFromJournal`,
`terminalStateReconstructedAfterSnapshotLoss`, `driveReportReDerivedAfterLoss`,
`journalUnchangedByRestore` and `auditGreenAfterRestore` in the install verifier.

## Rollback to a previous release

`resume` handles state continuity within one version. To move a run backward across versions,
restore the run directory from backup taken before the upgrade and verify with `audit`; a mismatch
between the journal fold and the report is a hard error (the journal wins).

## Uninstall

```bash
rm -rf <install-dir>            # the checkout (or extracted release tarball) itself
```

The install is self-contained: no global daemon, service, database or queue is registered; state
lives in `runs/` inside the install (and wherever you pointed `--jobs-root`). Keep `runs/` and the
Harbor job directories if you need the evidence afterwards — they are the audit trail. The
fresh-profile drill deletes the whole profile directory and asserts nothing remains.

## Backup

Cold-copy the run root and the jobs root while the CLI is stopped: `tar` the two directories and
store the checksums alongside. Because every object is content-addressed, a backup restores exactly
what `audit` verified.
