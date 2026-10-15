# Production provider readiness

Status: **READY FOR 0.1.1 WITH A MAINTAINER-AUTHORIZED SOAK WAIVER** for the production `qmapi` backend at
exact `qm-api-rs` revision
`75f6e4d392f6d3e64608fb48e2480fb0087009e3`.

The machine-readable record is [provider-readiness.json](provider-readiness.json).
Run `npm run provider:enforce` to verify the pin, provider boundary, evidence paths,
and source-retirement guards.

## Verified boundary

- `qm-api-rs` is the production implementation for clear-vkey retrieval,
  lyrics and QRC processing, and QMC decryption.
- The provider uses the `qmapi` credential envelope for production account
  operations. OAuth attempt/state staging, mutation reconciliation, entitlement decisions,
  transport policy, caching, artwork mapping, and wire DTO mapping remain
  YAQMC responsibilities.
- Retired in-tree fallback implementations are guarded from production source
  and dependency graphs by the readiness checker.
- The legacy session slot remains only as a bounded compatibility and rollback
  input; it is not the primary production credential.

## Evidence decision

Historical authenticated provider verification covered login/session resolution, clear
and encrypted playback sources, lyrics, seek continuity, account reads, and
favorite mutation reconciliation before cutover. The crate provenance record
is maintained separately in
[qm-api-rs-provenance.md](qm-api-rs-provenance.md).

The previous exact-pin waiver applied only to revision
`7d0f6e18b1d1d89a06cc5964e9c057acb0926ea5`; it is not carried forward.
The new pin adds typed discovery/account boundaries, OAuth URL construction,
credential isolation, response validation, the library-owned desktop QQ QR login
flow, the library-owned mobile QR launch URL, and the library-owned OAuth
callback endpoint contract. The QMC implementation is
unchanged; the limited source-evidence comparison is recorded in the provenance
document.

The original cutover remains authorized; its non-soak gates describe the historical
cutover, not a new LIVE run for this pin. Local synthetic tests do not establish
production-account, Android-device, or soak acceptance. The new exact-pin three-day
soak has not started. Its status is not recorded as a test pass.

## 0.1.1 release authorization

On 2026-10-15, maintainer Mai-xiyu requested publication of v0.1.1. After being
informed that the exact-pin three-day soak had not started and explicitly asked
whether to waive it for 0.1.1, the maintainer reiterated: “发布v0.1.1 release啊”.
This instruction authorizes the recorded `maintainer-authorized-skip` for
version 0.1.1 and pin `75f6e4d392f6d3e64608fb48e2480fb0087009e3` only.
The checker blocks reuse of this waiver at another version or dependency pin.
All other provider and provenance gates remain enforced. This is release
authorization, not evidence of a completed soak or fresh LIVE acceptance.

Android update support remains incomplete; the maintainer excluded Android from
this release. Only Windows and Linux desktop packages are published.
