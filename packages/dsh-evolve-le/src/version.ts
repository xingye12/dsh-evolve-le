/**
 * Builder/runner identity string shared by the build pipeline and the files
 * staged into capsules (SBOM creator, ACP agentInfo). Standalone so the
 * capsule runner tree can carry it without dragging in builder modules.
 * @module @dsh-evolve-le/core/version
 */

export const BUILDER_VERSION = 'dsh-evolve-le-builder-0.0.2'
