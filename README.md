# OSS Mission Orchestrator

Private Northset tool for a finite OSS contribute-first loop. The active contract is
[`OPERATING_CONTRACT.md`](OPERATING_CONTRACT.md); historical specs and architecture notes live
under `archive/` and are never runtime inputs.

## One-time local setup

Build the pinned author image once, and rebuild it only when its Dockerfile changes:

```sh
node bin/build-author-image.mjs
```

The author image contains Codex already. Target-repository dependencies still install with the
repository's declared command. Writable caches are keyed by canonical repository, base commit,
candidate or mission identity, executor-image digest, lockfile digest, and install-command digest,
so retries of one mission can reuse them without sharing mutable state across unrelated work.

## Find and qualify the next candidate

```sh
node find-candidates.mjs 1
```

The finder searches current, unassigned public issues, applies mechanical filters, and invokes
`review-issue.mjs` once per evidence snapshot. Its accepted JSON result is the single semantic
qualification artifact and is copied into the mission spec. Every ACCEPT is bound to a deterministic
`task_id` derived from `owner/repo#issue`; retries use a new mission ID and the next contiguous
`attempt_sequence`, while retaining that task ID. Do not rerun the reviewer for an unchanged snapshot.

Bounds:

- one review: five minutes;
- one finder invocation: twenty minutes;
- model reviews: `min(40, max(12, requested × 4))`;
- related PRs considered: twelve; hydrated in detail: eight;
- partial batches are valid terminal output with exit code `2`.

The finder is read-only. It neither claims issues nor changes repositories. It records reviewed
issue keys in `runs/candidate-history-v2.jsonl`, writes a content-bound batch plus an audit JSONL,
and supports a no-model preflight with `node find-candidates.mjs 20 --dry-run`. The existing
`OSS_FIND_LABELS`, `OSS_FIND_TERMS`,
`OSS_FIND_REPOS`, `OSS_FIND_STARS_MIN`, `OSS_FIND_SEARCH_LIMIT`, `OSS_FIND_CONCURRENCY`,
`OSS_FIND_HISTORY`, `OSS_FIND_OUTPUT`, and `OSS_FIND_EXCLUDE_FILES` controls remain available for
bounded research; none relax the reviewer gates.
See `CANDIDATE_FINDER.md` for the complete v3 search, preflight, audit, and exit-code contract.

For a scaled pilot, import existing rich qualifications once and keep model-free crawl/rank
separate from the bounded qualify queue:

```sh
node find-candidates.mjs import --out candidate_lake.sqlite batch-3.jsonl
node find-candidates.mjs crawl --profile node --out candidate_lake.sqlite
node find-candidates.mjs rank --lake candidate_lake.sqlite --count 100 --out runs/review-queue.json
node find-candidates.mjs qualify --lake candidate_lake.sqlite \
  --queue runs/review-queue.json --count 25 --out runs/qualifications.json
```

The local candidate lake preserves complete qualification JSON and provenance. Live mechanical
facts refresh independently; a cached ACCEPT or REJECT is usable only for the same unexpired
evidence key. Node remains the default existing profile. Python, Go, and Rust require explicit
selection and remain pilot profiles rather than production-proven profiles.

A combined `--profile node,python,go,rust` crawl assigns each repository exactly one profile before
lake persistence: a repository-policy override wins, then its primary language, then registry
order. Later profile passes cannot overwrite that assignment. A missing preseeded test command is
left for the bounded source-inspecting reviewer to derive; an ACCEPT still requires one exact,
deterministic harness command.

Lake qualification passes the queued evidence identity into the reviewer. The reviewer recomputes
that identity from its own live issue, comment, timeline, policy, and cloned-base observations;
drift is retryable and is never written under the queued key.
Repository-approved custom invitation labels travel with the complete policy snapshot and digest
through crawl, rank, qualify, and review, and are accepted only when the same live label and
content-bound policy are observed.

The standalone reviewer is available for a deliberately selected issue:

```sh
node review-issue.mjs owner/repo#123
```

An ACCEPT can also emit a schema-v2 draft, which is finalized only after the mission ID, attempt
sequence, repository-policy snapshot, exact oracle marker, and registry image are known:

```sh
node review-issue.mjs owner/repo#123 --profile node --emit-spec-draft \
  --test-path test/regression.test.mjs \
  --base-failure-contains 'exact failing test marker' > draft.json
node spec-finalize.mjs draft.json --mission-id M-100 --attempt-sequence 1 \
  --repo-policy-snapshot policy-snapshot.json --output specs/M-100.json
```

An ACCEPT binds `review_id`, prompt version, review and expiry timestamps, evidence digest and base
commit. Qualification expires after two hours. Expiry or a material live-state change makes that
attempt terminally stale; it does not cause an automatic second semantic review.

## Prepare exactly once

Create a current-schema JSON spec in `specs/`, using `examples/mission-spec.example.json` as the
shape, then run:

```sh
node oss.mjs prepare M-017
```

Prepare uses three local lanes by default; `--concurrency 1..12` is an explicit bounded override.
For a batch, warm each distinct executor image and repository mirror once before preparation:

```sh
node oss.mjs warm --batch-manifest batch.json --warm-output runs/batch-warm-cache.json
node oss.mjs prepare-batch --batch-manifest batch.json \
  --warm-manifest runs/batch-warm-cache.json
```

Warm resolves immutable image digests, smoke-tests each profile, initializes per-repository mirrors,
and reports disk readiness without deleting data. Prepare has one shared sixty-minute budget per
mission. It performs a deterministic live recheck, resolves the
executor image, clones the approved base, installs dependencies without credentials, runs one
red/green author attempt, squashes any author commits into one host-owned DCO commit directly on the
approved base, runs the differential oracle on read-only workspaces, and builds the exact public
bundle. The checkout passed to the canonical verifier is a standalone clone: it remains usable after
the author workspace and its shared mirror disappear. Prepare returns one READY board or a terminal
state such as `STALE`, `NOCHANGE`, `FAILED_BUDGET`, `FAILED_AUTHOR`, `FAILED_ORACLE`, or
`FAILED_INFRA_TERMINAL`.

The default fast lane permits production source and new oracle-bound regression tests. A modified
existing test requires explicit spec elevation and remains a recorded risk. A deterministic patch
review runs before READY and rejects renames, copies, type changes, snapshots, fixtures,
dependencies, lockfiles, CI, generated output, binaries, symlinks and submodules. It also rejects PR
body overclaims about maintainer approval, production readiness, security, vulnerability absence,
quality, correctness, predicted merge, or unscoped checks. The normalized PR claim text appears on
the human review board. Shipping independently recomputes the same policy from the exact bound base,
patch, spec, and PR-body bytes; the stored review digest is evidence rather than authority.
`oracle.setup_commands` is forbidden: the test must run on the committed tree after dependency
installation.

`test_only_then_fix` is the default authoring mode and stops before a fix attempt if no exact
base-red regression can be produced. `direct_fix` is available explicitly and must satisfy the same
test-only base failure plus one fresh canonical pass of the declared commands.

## Approve and ship the reviewed bytes

Prepare writes one machine-readable JSON board and one Markdown board for the ordered READY set.
The approval digest binds the ordered manifests, patch and PR-body hashes, patch-review risks, and
board data. The READY board prints the exact approval command:

```sh
node oss.mjs ship-batch --batch runs/boards/batch-<digest>.json \
  --approve sha256:<batch-manifest-digest> --approved-by internal-user:aeziz
```

`--approved-by` is a stable operator identifier, not a display name. For schema-v2 missions it is
written as a factual approval record after preparation; approval therefore remains distinct from
the signed preparation bundle while still appearing in the same canonical receipt.

Shipping accepts 1–50 missions (with a configurable lower maximum), preserves repository policy
caps, and initializes every approved journal plus one exact batch-approval record before the first
outbound action. It publishes one prepared-ledger batch, waits for Pages readiness once, processes
upstream PRs independently with bounded concurrency, and publishes one final-envelope batch. A
post-freeze failure is recorded for that mission without silently skipping or duplicating an
unrelated mission. Prepared-ledger destinations and approvals are all prevalidated before local
mutation; valid missions are staged as one rollback-capable subset, while a conflicting mission is
recorded independently. The per-mission forward-only order is:

```text
APPROVED -> PRE_PUBLIC_RECHECK -> PUSHED -> PREPARED_RECEIPT_PUBLISHED -> ATTESTED
         -> RECEIPT_AVAILABLE -> PRE_PR_COLLISION_CHECK -> PR_OPENED
         -> DISCLOSURE_SYNCED -> FINAL_ENVELOPE_PUBLISHED -> SHIPPED
```

The full pre-public recheck occurs before fork creation, push or ledger publication. Both the
prepared receipt and the final publication envelope land through ledger pull requests whose required
checks must pass before merge; ship never pushes ledger changes directly to `main`. The canonical
receipt must return HTTP 200 before the upstream PR opens. The guarded synchronizer then updates only
the exact PR's marked receipt block and records `pr_disclosure` before the final ledger PR. A narrow
collision check runs immediately before PR creation. A pre-public stale result makes zero outbound
changes; a post-public collision leaves the receipt in its prepared state and consumes the mission
ID. One infrastructure retry is allowed inside the original deadline. A terminal journal may restart
only after a newly approved changed manifest, with the prior attempt archived unchanged.
The contributor metric is counted only when the journaled upstream PR URL belongs to the manifest's
repository (case-insensitively), its number matches any recorded PR number, and all exact patch,
receipt-publication, and receipt-link bindings hold; merge is not required.

## Reconcile upstream outcomes

```sh
node oss.mjs status
```

Status updates mutable publication envelopes from factual GitHub state, resynchronizes the exact
state-specific marked PR-body block, and publishes the rebuilt ledger through another checked pull
request without changing immutable bundles.

## Load-bearing invariants

- One model qualification per immutable evidence snapshot; prepare never requests another reviewer.
- One author attempt and one canonical DCO commit whose only parent is the approved base.
- Dependency and author containers receive a writable worktree but a nested read-only `.git` mount.
- Verification runs network-off with the workspace bind read-only and `/tmp` as writable scratch.
- Every subprocess shares its enclosing deadline, has bounded output, and is terminated as a process
  group with SIGTERM followed by SIGKILL after two seconds.
- Content-bound approval covers the patch, commit/tree, issue and policy snapshots, oracle, public
  bundle, PR text, patch review, ordered batch board and outbound actions.
- A schema-v2 bundle signs `bundle/economic.json`: task and attempt identity, observed stage effort,
  measured resource fields, verified work scope, and factual cost lines. The immutable top-level
  `approval.json` records the later human approval; mutable `publication.json` records upstream state.
- Economic fields are evidence-bound facts only. Unobserved timing, usage, rates, and money remain
  `null` or explicitly unavailable; missing components prohibit a claimed total economic cost.
- Receipt language remains direct and modest: contributor self-run, not maintainer verification.
- A contributor receipt counts only after exact local patch/PR-body verification, public receipt
  availability, and creation of the upstream PR with that receipt link; merge is not required.
- No terminal state transitions back to review or preparation.

Every mission receives the same fixed, bounded gate. When the gate's time or capacity budget is
exhausted, return a partial batch or reject the candidate; never increase review depth to chase
completeness.

Run the focused orchestrator and scaling checks with:

```sh
node --test find-candidates.test.mjs review-issue.test.mjs oss.test.mjs ship.test.mjs \
  candidate-lake.test.mjs spec-finalize.test.mjs review-patch.test.mjs
node bin/verify-scaling-redesign.mjs
```

The public verifier remains `/Users/aeziz-local/northset-oss/bin/run-mission.mjs`; prepare invokes it
with `--require-success`, and ship publishes those exact bytes rather than rebuilding them.
