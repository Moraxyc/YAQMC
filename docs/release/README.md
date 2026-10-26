# Release requirements

Audit reports, source-provenance reviews and release-gate records remain on the
maintainer's machine. They are ignored by Git and must not be committed or pushed,
including through earlier unpublished commits. Public release instructions and
the license and copyright records remain in the repository.

The existing provenance, provider-readiness and corresponding-source checks
remain mandatory. Their private input files keep their local `docs/release/`
paths. A checkout without those inputs must stop at the gates; absence does not
grant approval or waive a soak. Public release assembly remains blocked until
private evidence can be validated without adding the reports to Git or published
source archives.

- [Licensing consent](../../LICENSING_CONSENT.md) and its machine-readable
  [consent record](licensing-consent-record.json) preserve the recorded approvals.
- [Third-party notices](../../THIRD_PARTY_NOTICES.md) preserve applicable copyright
  statements and license notices.
- [Corresponding-source policy](../../CORRESPONDING_SOURCE_POLICY.md) specifies the
  exact source and license set required for a binary distribution.
- [CI documentation](../ci.md) describes the build and packaging commands.
