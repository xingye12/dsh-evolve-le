/**
 * Pinned Terminal-Bench 2.1 dataset source (Gate 2, specs/04 §2-3, CLAUDE.md
 * rule 8): every external input is content-addressed. The tasks the provider
 * plans against are the materialized content of exactly this tarball; the
 * inventory manifest records the pin and the per-task tree digests, so a run
 * can be re-derived from the pin alone. `tb/` in this repo predates the 2.x
 * Harbor-native task format and is NOT the source.
 * @module @dsh-evolve-le/tb-provider/dataset
 */

/** Content-addressed pin of the upstream task set. Frozen; changes need an ADR. */
export const DATASET_PIN = {
  id: 'terminal-bench-2-1',
  upstream: 'harbor-framework/terminal-bench-2-1',
  commit: '7131e4375048a0e408a8fb404b5f499d726b695b',
  tarballUrl:
    'https://codeload.github.com/harbor-framework/terminal-bench-2-1/tar.gz/7131e4375048a0e408a8fb404b5f499d726b695b',
  tarballSha256: 'aa992a8848a1f3ed5191a34fa72ed5700d67dd9f968413a0e0a567b6188cb527',
  /** Top-level directory inside the tarball (`<repo>-<commit>/`). */
  rootDir: 'terminal-bench-2-1-7131e4375048a0e408a8fb404b5f499d726b695b',
  /** Directory of Harbor-native task directories inside the root. */
  tasksDir: 'tasks',
} as const

export type DatasetPin = typeof DATASET_PIN
