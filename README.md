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
repository's declared command, using a cache keyed by executor-image digest, lockfile digest and
install-command digest.

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
See `CANDIDATE_FINDER.md` for the complete v2 search, preflight, audit, and exit-code contract.

The standalone reviewer is available for a deliberately selected issue:

```sh
node review-issue.mjs owner/repo#123
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

Prepare has one shared sixty-minute budget. It performs a deterministic live recheck, resolves the
executor image, clones the approved base, installs dependencies without credentials, runs one
red/green author attempt, squashes any author commits into one host-owned DCO commit directly on the
approved base, runs the differential oracle on read-only workspaces, and builds the exact public
bundle. It returns one READY board or a terminal state such as `STALE`, `NOCHANGE`,
`FAILED_BUDGET`, `FAILED_AUTHOR`, `FAILED_ORACLE`, or `FAILED_INFRA_TERMINAL`.

The fast lane permits source files, new tests, and at most one prominently flagged modified existing
test. It rejects renames, copies, type changes, snapshots, fixtures, dependencies, lockfiles, CI,
generated output, binaries, symlinks and submodules. `oracle.setup_commands` is forbidden: the test
must run on the committed tree after dependency installation.

## Approve and ship the reviewed bytes

The READY board prints the exact approval command:

```sh
node oss.mjs ship --approve sha256:<batch-manifest-digest> --approved-by internal-user:aeziz M-017
```

`--approved-by` is a stable operator identifier, not a display name. For schema-v2 missions it is
written as a factual approval record after preparation; approval therefore remains distinct from
the signed preparation bundle while still appearing in the same canonical receipt.

Ship has one shared sixty-minute budget per mission and initializes every approved journal before
the first outbound action. Its forward-only order is:

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
  bundle, PR text and outbound actions.
- A schema-v2 bundle signs `bundle/economic.json`: task and attempt identity, observed stage effort,
  measured resource fields, verified work scope, and factual cost lines. The immutable top-level
  `approval.json` records the later human approval; mutable `publication.json` records upstream state.
- Economic fields are evidence-bound facts only. Unobserved timing, usage, rates, and money remain
  `null` or explicitly unavailable; missing components prohibit a claimed total economic cost.
- Receipt language remains direct and modest: contributor self-run, not maintainer verification.
- No terminal state transitions back to review or preparation.

Every mission receives the same fixed, bounded gate. When the gate's time or capacity budget is
exhausted, return a partial batch or reject the candidate; never increase review depth to chase
completeness.

Run private tests with:

```sh
node --test *.test.mjs
```

The public verifier remains `/Users/aeziz-local/northset-oss/bin/run-mission.mjs`; prepare invokes it
with `--require-success`, and ship publishes those exact bytes rather than rebuilding them.
