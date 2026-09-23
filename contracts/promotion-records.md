# Contract: promotion-records

- **Status:** frozen v1
- **Owner:** promotion verbs (`propose` writes both records; `finalize` completes them) — stages 43/44. Governing ADRs: 0021 (D10 lifecycle + records), 0022, 0023. Tracking: #107.

## Exposes

The two-sided evidence trail of every promotion — the concrete implementation
of the "Verity deployment packet" (ADR-0021):

1. **Public `RELEASE-MANIFEST.json`** — prod repo root, rewritten by each
   promotion branch. Sanitized: carries dev identifiers (commit SHA) as
   correlation IDs, never dev URLs, issue titles, branch names, internal
   paths, or secret locations.
2. **Private `.verity/promotions/PROM-####.yml`** — dev repo, append-only
   numbering, one per promotion attempt. The full cross-repo trace. Immutable
   after `finalize` records completion; a superseding promotion is a new
   record.

## Consumes

The projection report (`production-projection` contract v1): `source_commit`,
`classification_digest`, `staging_digest`, and the `verify` block are COPIED
into the records, never recomputed. `.verity/promotion.json` (`prod_repo`,
`prod_owned` globs per ADR-0023).

## Schema / wire

`RELEASE-MANIFEST.json` (public, prod root):

```json
{
  "schema": 1,
  "version": "1.2.0",
  "promotion_id": "PROM-0001",
  "development_commit": "<full sha>",
  "classification_digest": "sha256:<hex>",
  "staging_digest": "sha256:<hex>",
  "package_shasum": "<sha1 from npm pack>",
  "verify": { "gates": "all-pass", "baseline": "<matched version | null>" },
  "promoted_at": "<iso8601>"
}
```

`.verity/promotions/PROM-####.yml` (private, dev):

```yaml
promotion_id: PROM-0001
version: 1.2.0
status: proposed | promoted | released | abandoned
development:
  repository: seanerama/verity-dev
  commit: <full sha>
  staging_digest: sha256:<hex>
  classification_digest: sha256:<hex>
production:
  repository: seanerama/verity-framework
  pull_request: <number | null>
  commit: <full sha | null>     # set by finalize
  tag: v1.2.0                   # set by finalize
verification:
  gates: all-pass
  package_shasum: <sha1>
  baseline: <matched version | null>
timestamps:
  proposed_at: <iso8601>
  finalized_at: <iso8601 | null>
```

Rules: `status` moves forward only (proposed → promoted → released; abandoned
is terminal from proposed/promoted). `finalize` verifies the merged prod tree's
RELEASE-MANIFEST matches the PROM record (version + digests) before tagging —
a mismatch aborts, tagging nothing.

Additive notes on `status` (ADR-0035): `promoted` and `abandoned` are
reserved — not emitted in v1 (ADR-0035). The engine writes `proposed`
(`propose`) → `released` (`finalize`) only, and `finalize` refuses a record
whose `status` is not `proposed`. `finalize`'s command output
`published: not-triggered | workflow-triggered` reflects what finalize
*caused* (whether it triggered the publish workflow), not what the registry
shows; it is command output, not a record field.

### Additive v1.x fields (ADR-0035)

OPTIONAL `publish:` section of the PROM record — evidence only, recorded by
hand after the registry publish is observed; never engine-written, and NOT a
`status` transition:

```yaml
publish:
  registry: <string>              # e.g. registry.npmjs.org
  package: <string>               # e.g. verity-framework@1.2.0
  published_at: <iso8601>
  registry_shasum: <sha1>
  shasum_matches_record: <bool>   # registry_shasum == verification.package_shasum
  method: <string>
```

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.

Amended additively 2026-09-23 per ADR-0035: marked `promoted`/`abandoned`
reserved (not emitted in v1), documented the optional evidence-only `publish:`
section and the meaning of finalize's `published:` output.
