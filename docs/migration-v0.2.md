# v0.2 migration to dsh-evolve-le

v0.2 renames every live product-facing identity from `dsh-RSI` / `dsh-rsi` to `dsh-evolve-le`:

| Surface              | v0.2 identity                            |
| -------------------- | ---------------------------------------- |
| npm scope            | `@dsh-evolve-le/*`                       |
| CLI                  | `dsh-evolve-le`                          |
| Cordis service       | `ctx.selfEvolving`                       |
| core package         | `@dsh-evolve-le/core`                    |
| protocol             | `dsh-evolve-le-candidate-tree-v2`        |
| evidence MIME prefix | `application/vnd.dsh-evolve-le.*`        |
| private state root   | `/var/lib/dsh-evolve-le-controller`      |
| source identity      | `.dsh-evolve-le-source-identity.json`    |
| source archive       | `dsh-evolve-le-v<version>-source.tar.gz` |

Package directories carrying the former project prefix are likewise renamed to `packages/dsh-evolve-le*`.
Environment variables use the `DSH_EVOLVE_LE_` prefix.

The rename is a fresh-lineage boundary. Existing v0.1/v0.1.1 state, capsules, journal events, protocol strings,
absolute paths, hashes and audits are not rewritten or upgraded in place. They remain valid predecessor evidence
under their original names. Start v0.2 with a new run ID and a new state directory.
