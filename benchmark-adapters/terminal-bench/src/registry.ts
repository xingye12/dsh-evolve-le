/**
 * Inline ACP binary registry entry (Gate 2, specs/07 §4; CLAUDE.md rule 2):
 * the capsule archive is distributed to the task container exactly the way
 * Harbor's installed `acp` agent consumes upstream registry entries — an
 * `AcpRegistryEntry` whose `distribution.binary[<platform>]` points at an
 * HTTPS tar.gz with a sha256 checksum. Harbor downloads it inside the task
 * container with `curl -fsSL` (strict TLS), verifies the checksum via
 * python3, extracts to /opt/harbor-acp-agent/dist, and execs
 * `<install>/dist/<cmd basename> <args…>`. Field names and validation rules
 * here bind to harbor 0.21.0 `src/harbor/agents/installed/acp.py`
 * (`AcpRegistryEntry`, `AcpBinaryTarget`).
 * @module @dsh-evolve-le/tb-provider/registry
 */

/** The capsule's wrapper file name staged at the archive root (capsule.ts). */
export const ACP_CMD = './dsh-evolve-le-acp'

/**
 * Registry entry id/name. Harbor records it as the trial's `agent_info.name`
 * (observed: `agent_info.name` = registry id, NOT the job-config agent slot
 * name), so the normalizer's attribution check binds against this constant.
 */
export const ACP_AGENT_ID = 'dsh-evolve-le-capsule'

export interface RegistryEntryInput {
  /** Candidate capsule tar.gz digest — the version identity Harbor records per trial. */
  capsuleArchiveSha256: string
  /** HTTPS URL serving the capsule archive (local content-addressed endpoint). */
  archiveUrl: string
  /** Harbor platform id the entry targets (detected in-container via uname). */
  platform?: string
}

export interface AcpRegistryEntry {
  id: string
  name: string
  version: string
  description: string
  distribution: {
    binary: Record<string, { archive: string; cmd: string; args: string[]; checksum: string }>
  }
}

/**
 * Build the inline registry entry. `version` carries the capsule archive
 * sha256 so the trial record's `agent_info.version` binds the paid trial to
 * the exact evaluated candidate (the normalizer verifies this).
 */
export function buildAcpRegistryEntry(input: RegistryEntryInput): AcpRegistryEntry {
  if (!/^https:\/\//.test(input.archiveUrl)) {
    throw new Error(
      `registry: archive URL must be HTTPS (harbor AcpBinaryTarget): ${input.archiveUrl}`,
    )
  }
  if (!/^[0-9a-f]{64}$/.test(input.capsuleArchiveSha256)) {
    throw new Error('registry: capsuleArchiveSha256 must be a 64-hex sha256')
  }
  return {
    id: ACP_AGENT_ID,
    name: ACP_AGENT_ID,
    version: input.capsuleArchiveSha256,
    description:
      'dsh-evolve-le candidate capsule: Cordis composition booted through the real Loader, serving ACP with a deterministic recorded-LLM replay. Builder-authored, content-addressed.',
    distribution: {
      binary: {
        [input.platform ?? 'linux-x86_64']: {
          archive: input.archiveUrl,
          cmd: ACP_CMD,
          args: [],
          checksum: input.capsuleArchiveSha256,
        },
      },
    },
  }
}
