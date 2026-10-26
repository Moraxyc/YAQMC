# GPL-3.0-or-later licensing consent and provenance record

## Scope

This record covers YAQMC's GPL-3.0-or-later adoption, repository LICENSE, package/crate metadata, corresponding-source
policy, and every contribution or imported asset distributed with the work. It is a release gate;
it is not proof that any person has approved, owns, or may relicense any contribution.

## Full rights audit requirement

A GPL license decision cannot be cleared by two maintainer approvals alone. Each independently copyrightable
contribution, imported code path, generated output, and binary asset needs one of:

- immutable license and source evidence establishing the required distribution rights;
- explicit contributor/relicensing authorization from a person who controls those rights; or
- a documented independent rewrite or removal.

Unknown origin, NOASSERTION, missing immutable revision, incomplete target mapping, pending consent, and proprietary
extraction without authorization are release blockers. Corresponding-source delivery is necessary where GPL applies,
but it does not cure missing copyright permission.

The complete audit state remains in the maintainer's local
`docs/release/provenance-ledger.json` and `docs/release/provenance.md` files.
These private reports are excluded from Git; see the
[release requirements](docs/release/README.md).
The typed maintainer-approval digest is
[docs/release/licensing-consent-record.json](docs/release/licensing-consent-record.json).
The linked `qm-api-rs` (`qqmusic-api`) crate requires its separate local
`docs/release/qm-api-rs-provenance.md` review.

## Maintainer records

The entries below remain required evidence for rights the named maintainers actually control. They do **not** by
themselves clear external notices or linked dependencies. Record an immutable evidence reference (for example, a
signed commit or GitHub issue/PR comment URL) and date beside each approval.

| Required approver | Status   | Evidence reference                                                        | Recorded date | Limited scope                               |
| ----------------- | -------- | ------------------------------------------------------------------------- | ------------- | ------------------------------------------- |
| Mai-xiyu          | approved | `sha256:92e5f1990f8b36992da9de37667492ef6807912aa8a55ec6edc30556382c178b` | 2026-08-21    | Only rights actually controlled by Mai-xiyu |
| Osilvfe           | approved | `sha256:92e5f1990f8b36992da9de37667492ef6807912aa8a55ec6edc30556382c178b` | 2026-08-21    | Only rights actually controlled by Osilvfe  |

## Current status

`npm run provenance:enforce` must validate the private evidence before a release.
A checkout without that evidence does not establish a passing status. QMCDecode's
MIT copyright and license notices remain in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
