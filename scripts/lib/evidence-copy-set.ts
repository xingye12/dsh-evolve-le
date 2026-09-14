/**
 * Proposal-saga evidence copy set (ADR-043, rule 7): the per-expansion
 * receipts a live-run record must preserve before the scratch root is
 * deleted. Returns `[source, destinationName]` pairs for the evidence
 * artifacts directory:
 *
 * - every object-store file (`objects/sha256/<prefix>/<hex>`) flat-named
 *   `object-<hex>` — the content-addressed store holds the proposal
 *   validation summaries with per-child rejected reasons, proposal bundles,
 *   transcripts, gateway and remote receipts, normalized trials and
 *   admission receipts (all collected by the controller as artifacts);
 * - `search-state.json` (expansion counters, rebuild rejections, abandoned
 *   intents) and `failure-pool.json` (the frozen pool) verbatim;
 * - per-expansion `worker-result.json` as `<actionId>-worker-result.json`
 *   (boot facts, DAC probes, worker verdict — the one sandbox fact the
 *   store does not persist), plus `failure-transcript.jsonl` when native
 *   proposal execution failed before `proposal_finish`.
 *
 * Scope is deliberately exact: staged/non-digest object files, the sandbox
 * dirs themselves (hundreds of MB of staged capsule inputs) and the
 * `*-remote/remote-receipts.jsonl` sidecars (already inside the store) are
 * not copied. Flat top-level names keep the record scripts' redaction scan
 * (rule 8) covering every new file unchanged.
 * @module scripts/lib/evidence-copy-set
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const DIGEST_NAME = /^[0-9a-f]{64}$/

export async function proposalEvidenceCopies(
  runRoot: string,
): Promise<Array<[string, string]>> {
  const copies: Array<[string, string]> = []

  const objectsRoot = join(runRoot, 'objects', 'sha256')
  const prefixes = await readdir(objectsRoot).catch(() => [] as string[])
  for (const prefix of prefixes.sort()) {
    const names = await readdir(join(objectsRoot, prefix)).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (DIGEST_NAME.test(name)) {
        copies.push([join(objectsRoot, prefix, name), `object-${name}`])
      }
    }
  }

  for (const file of ['search-state.json', 'failure-pool.json']) {
    const source = join(runRoot, file)
    if ((await stat(source).catch(() => undefined))?.isFile() === true) {
      copies.push([source, file])
    }
  }

  const sandboxesRoot = join(runRoot, 'controller', 'sandboxes')
  const sandboxDirs = await readdir(sandboxesRoot).catch(() => [] as string[])
  for (const dir of sandboxDirs.sort()) {
    for (const [file, destination] of [
      ['worker-result.json', `${dir}-worker-result.json`],
      ['failure-transcript.jsonl', `${dir}-failure-transcript.jsonl`],
    ] as const) {
      const source = join(sandboxesRoot, dir, 'work', file)
      if ((await stat(source).catch(() => undefined))?.isFile() === true) {
        copies.push([source, destination])
      }
    }
  }

  return copies
}
