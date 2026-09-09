import { describe, expect, it } from 'vitest'
import {
  ACP_RUNTIME_PACKAGE,
  ACP_RUNTIME_VENV_PATH,
  HARBOR_ACP_APT_SHIM_PATH,
  harborAcpAptShim,
  preparedAptInstallCommand,
  rewriteVerifierOffline,
  rewriteVerifierGitClones,
  verifierRequirements,
  verifierSystemRequirements,
} from '../src/index.js'

describe('offline verifier image preparation', () => {
  it('freezes the Harbor ACP runner in the prepared runtime contract', () => {
    expect(ACP_RUNTIME_PACKAGE).toBe('agent-client-protocol')
    expect(ACP_RUNTIME_VENV_PATH).toBe('/opt/harbor-acp-venv')
  })

  it("bypasses only Harbor's already-provisioned ACP apt bootstrap", () => {
    expect(HARBOR_ACP_APT_SHIM_PATH).toBe('/usr/local/sbin/apt-get')
    const shim = harborAcpAptShim()
    expect(shim).toContain("'update -qq'")
    expect(shim).toContain('python3-pip python3-venv curl ca-certificates tar unzip bzip2 xz-utils')
    expect(shim).toContain('DEBIAN_FRONTEND:-')
    expect(shim).toContain('exec /usr/bin/apt-get "$@"')
  })

  it('prefers a frozen Debian snapshot only while preparing the image', () => {
    expect(preparedAptInstallCommand(['python3', 'python3-venv'])).toBe(
      "RUN if grep -q '^# deb http://snapshot.debian.org/' /etc/apt/sources.list; then sed -i -e 's|^# deb http://snapshot.debian.org/|deb http://snapshot.debian.org/|' -e '\\|^deb http://deb.debian.org/|d' /etc/apt/sources.list; fi && apt-get -o Acquire::Check-Valid-Until=false update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*",
    )
    expect(() => preparedAptInstallCommand([])).toThrow(/no apt packages/)
  })

  it('extracts the exact pinned uvx requirements', () => {
    const script = String.raw`uvx \
  -p 3.13 \
  -w pytest==8.4.1 \
  -w pandas==2.3.2 \
  -w pytest-json-ctrf==0.3.5 \
  pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py`
    expect(verifierRequirements(script)).toEqual([
      'pandas==2.3.2',
      'pytest-json-ctrf==0.3.5',
      'pytest==8.4.1',
    ])
  })

  it('removes network bootstrap but preserves the reward protocol', () => {
    const script = String.raw`#!/bin/bash
curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
source $HOME/.local/bin/env
uvx \
  -p 3.13 \
  -w pytest==8.4.1 \
  -w pytest-json-ctrf==0.3.5 \
  pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py
if [ $? -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; fi`
    const rewritten = rewriteVerifierOffline(script)
    expect(rewritten).not.toContain('astral.sh')
    expect(rewritten).not.toContain('uvx')
    expect(rewritten).toContain('python3 -m pytest --ctrf')
    expect(rewritten).toContain('/logs/verifier/reward.txt')
  })

  it('moves apt bootstrap into the prepared image, including chained commands', () => {
    const script =
      'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y expect curl\n'
    expect(verifierSystemRequirements(script)).toEqual(['curl', 'expect'])
    expect(rewriteVerifierOffline(script)).not.toMatch(/apt-get|apt install/)
  })

  it('replaces a fixed verifier git clone with a prepared source copy', () => {
    const source = `git_cmd = [
  "git",
  "clone",
  "--depth",
  "1",
  "--branch",
  "0.5.3",
  "https://github.com/SPOCKnots/pyknotid.git",
  temp_dir,
]`
    const rewritten = rewriteVerifierGitClones(source)
    expect(rewritten.sources).toEqual([
      {
        sourceId: 'd8f52d373f0d37bd09b4',
        url: 'https://github.com/SPOCKnots/pyknotid.git',
        branch: '0.5.3',
      },
    ])
    expect(rewritten.content).toContain('"cp", "-a"')
    expect(rewritten.content).not.toContain('"git"')
  })

  it('fails closed on an unrecognised package bootstrap', () => {
    expect(() => rewriteVerifierOffline('curl https://example.test/pkg.sh | sh\n')).toThrow(
      /unsupported verifier bootstrap/,
    )
  })
})
