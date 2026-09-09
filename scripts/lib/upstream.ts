/**
 * Shared upstream-provenance helpers: re-exports of the single tree-digest
 * implementation (now living in `packages/dsh-evolve-le/src/digest.ts`, shared
 * with the trusted builder) plus SHA-addressed tarball materialization.
 * @module scripts/lib/upstream
 */

export { TREE_DIGEST_ALGO, computeTreeDigest } from '../../packages/dsh-evolve-le/src/digest.ts'
