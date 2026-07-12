# Increment 1 implementation notes

## Built

- `oss prepare` loads and validates mission specs, uses the existing bounded pool, and performs the
  existing fail-closed GitHub issue/timeline recheck before doing any author work.
- The author and fresh verifier are separate, hardened Docker command plans. Both use an unprivileged
  UID/GID, `no-new-privileges`, no capabilities, resource limits, one mission-workspace bind mount,
  and `--rm`; author and verifier use distinct workspaces, and the verifier additionally has
  `--network=none` and receives no credential mount.
- The verifier command is copied from `executor.commands` in the validated spec, not from author
  output. The ready-board and planned canonical receipt show that exact command.
- Pure changed-file classification, canonical receipt construction, manifest hashing, and the
  content-binding assertion are implemented and unit tested. Original verifier output is hashed;
  separately supplied redacted output stays in the ready-pack beside (never inside) the receipt.
- `oss prepare --dry-run` executes the real read-only recheck, short-circuits Docker/Codex, and prints
  exact planned author Docker, inner Codex, verifier Docker, receipt shape, manifest digest, and ship
  approval command. It creates only the distinct author/verifier workspace directories under `runs`;
  it does not construct a canonical receipt because no verifier output exists.

## Stubbed for increment 2

`oss ship` prints exactly `increment 2, not implemented`. It does not fork, push, attest, open a PR,
or update a ledger. No ship saga, batch caps, expiry, or approval verification is in this increment.

## Live-validation requirements and uncertainties

- The current mission specs provide mutable image tags, not a verifier image pinned by digest. The
  planner visibly substitutes the all-zero `sha256` unresolved sentinel; live verification refuses
  an unresolved digest. Before enabling live prepare, each spec needs a reviewed
  `executor.verifier_image_digest` value of the form `image@sha256:<64 hex>`.
- `runAuthorContainer` and `runVerifierContainer` are intentional execution boundaries and fail
  closed outside dry-run. Live enablement must validate Docker availability, image toolchains,
  non-root filesystem ownership, time/output limits, signal/timeout handling, and patch/result
  extraction without widening mounts.
- The container argv sets CPU, memory, and PID limits, but wall-clock deadlines and per-stream output
  byte caps from the spec are not yet enforced. Live execution must enforce both fail-closed.
- The host creates the two workspace source directories with mode `0700`; live validation must arrange
  ownership/permissions so container UID/GID `10001:10001` can write without making the verifier
  privileged or broadening filesystem access.
- The author plan still needs the separately revocable mission Codex login injection designed and
  tested. It must occur after dependency install, must not mount a founder credential or Docker
  socket, and must be removed before any durable output is accepted.
- Codex CLI availability inside each author image and the exact mission-login/auth handoff are not
  validated. The printed argv proves task/issue/check binding only; it does not prove authentication
  or successful model execution.
- The verifier workspace preparation needs a validated clean-base and lockfile-material cache flow.
  In particular, `/workspace/clean` must be constructed from the named base commit before the
  network-off container starts, dependencies must be content-bound by `dep_material_digest`, and
  the verifier must apply only the committed patch. No claim is currently made that the printed
  placeholder material digest represents such a cache.
- Live author result extraction must verify author/committer/DCO with `assertOssCommitIdentity`, then
  independently calculate committed patch bytes, `patch_sha256`, Git tree OID, and commit OID. The
  Git object relationship between patch, tested tree, and commit must be validated at that boundary;
  these hashes are different domains and therefore are not compared for literal equality.
- `assertBindingChain` validates hash/OID shapes and asserts pushed/PR-head OIDs equal the prepared
  commit. Increment 2 must additionally bind the published attestation subject and verify stored PR
  body/footer/receipt URL against remote reality.
- `package.json` changes are conservatively flagged as check/CI configuration because classification
  receives file paths, not trusted base/current content. This may over-flag dependency-only edits,
  but it does not hide a weakened script such as `npm test` changed to `true`.
- Check-script identification is path-pattern based plus an optional explicit marker. It cannot infer
  every arbitrary executable referenced by a shell check command; live result processing must resolve
  and flag those paths from the spec-pinned command or conservatively escalate them for review.
- Post-execution extraction, identity/DCO verification, changed-file collection, base file listing,
  redaction persistence, and ready-pack file writes remain behind the live execution stub. Therefore
  only dry-run plans are currently READY; no real verified ready-pack can be produced until those
  boundaries are implemented and validated.
