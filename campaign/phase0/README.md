# Phase 0 source/environment seal

`source-seal.mjs` implements the source/environment portion of campaign Phase 0.1. It
refuses a dirty Git worktree, creates and verifies `git bundle --all`, archives full test
output, and emits a canonical manifest plus SHA-256 sidecar.

```sh
node campaign/phase0/source-seal.mjs \
  --repo /Users/aeziz-local/oss-orchestrator \
  --output /Users/aeziz-local/oss-orchestrator/.phase0-artifacts/2026-07-17/source-seal \
  --test-output /path/to/full-test-output.log
```

When `--output` is omitted, the command uses
`.phase0-artifacts/2026-07-17/source-seal` below the supplied repository. An in-repository
artifact root is accepted only when Git ignores it, so artifact creation cannot make the
sealed worktree dirty.

The manifest records the exact Git HEAD/ref set, bundle digest and heads, Node/Git/Docker
versions, tracked lockfiles, custom Dockerfiles, profile registries, database schema-version
constants, migration files, and policy files. File digests are taken from tracked Git blobs,
not from ignored or mutable runtime data.

The manifest bytes are deterministic for the same source refs, bundle, test output, and
environment. `seal-manifest.sha256` is ready for an operator to check before applying a
detached signature.

This command does **not** sign the manifest, export OCI images, create SBOMs, copy artifacts
off-machine, archive the live candidate lake/journal, or prove a clean-VM restore. Those
Phase 0.1 obligations remain separate gates and are explicitly `false` in this lane's
manifest until independently completed.

## Other Phase 0 controls

- `protocol.v1.json` is the preregistered campaign protocol. A signed freeze record must be
  verified against a rostered public key before launch.
- `batch-rehearsal.mjs` models the 25-mission happy path and every required recovery
  scenario without contacting GitHub. Its automated test records external-action counts,
  state transitions, and counter outcomes for each scenario. It is model evidence, not a
  substitute for driving the production shipping state machine through fake GitHub
  adapters; the exit gate remains pending until that production-path suite exists.
- `roster/reviewers.json`, `calibration-schedule.json`, and `handoff-template.json` are
  deliberately honest about pending second-operator work. A template or scheduled review
  is not evidence that a handoff or calibration has happened.
- `github-support-inquiry.draft.md` is prepared but not sent. Sending it is a third-party
  communication and requires explicit operator authorization.

The publication authorization sequence is intentionally fail closed: each operator appends
a signed `review-records.json` record to the READY pack with `sign-review`; the operator
then runs `finalize-reviewed-board` so the board digest includes those exact signed-review
bindings; the batch approver signs that reviewed board; and `oss.mjs ship-batch` verifies
the review set, roster, deterministic dual-review rule, and signed batch record before its
first outbound action. A free-form `--approved-by` value is no longer accepted.

`backup-cli.mjs` creates an AES-256-GCM encrypted, authenticated lake/journal archive from a
SQLite-consistent backup and restores it with per-file digest and `PRAGMA integrity_check`
verification. The encryption key must remain outside the repository and should be escrowed
separately from the cloud archive.
