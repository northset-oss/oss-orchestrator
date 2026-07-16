# Northset OSS Candidate Finder v3

The original `node find-candidates.mjs N` workflow remains available. The scaling path separates
mechanical discovery from semantic qualification and stores durable evidence in
`candidate_lake.sqlite`.

It produces a batch of high-confidence **candidate qualifications**, not an unverified list of
interesting issue URLs. Every selected row has passed:

1. deterministic GitHub discovery from an auditable query plan;
2. live mechanical preflight against repository and issue state;
3. an exact-evidence cache lookup, followed by at most one `review-issue.mjs` semantic review when
   the candidate is not deterministically rejected;
4. Tier A + requested executor-profile enforcement;
5. repository and owner diversity rules.

A run ends when the requested batch is found, the eligible queue is exhausted, or the one global
wall-clock budget expires. There are no review loops and no automatic second opinion.

## Install

Keep these files together in `/Users/aeziz-local/oss-orchestrator/`:

```text
find-candidates.mjs
find-candidates.test.mjs
candidate-lake.mjs
candidate-lake.test.mjs
profiles.json
```

Keep the existing `review-issue.mjs` and `repo-policy.json` beside them.

Run the tests:

```sh
node --test find-candidates.test.mjs
```

## Normal use

```sh
# Find five candidates.
node find-candidates.mjs 5

# Find twenty candidates under the same fixed 20-minute budget.
node find-candidates.mjs 20

# Review only targeted repositories.
node find-candidates.mjs 10 --repos owner/repo,other/project

# Expand exact invitation-label variants deliberately.
node find-candidates.mjs 10 \
  --labels 'good first issue,help wanted,E-help-wanted,Effort: Good First Issue'

# Inspect discovery and live preflight without spending model reviews.
node find-candidates.mjs 20 --dry-run
```

## Lake-backed scaling path

```sh
# Idempotently consolidate existing Batch 3 JSON or JSONL qualifications.
node find-candidates.mjs import --out candidate_lake.sqlite batch-3.json batch-3.jsonl

# Refresh live mechanical facts only. No semantic reviewer runs here.
# This documented default expands to 18 bounded queries (six Node bases by three windows).
node find-candidates.mjs crawl --profile node --out candidate_lake.sqlite \
  --created-window-days 90 --search-shards 3

# Build a bounded deterministic queue. This also runs no semantic reviewer.
node find-candidates.mjs rank --lake candidate_lake.sqlite \
  --profile node --count 100 --out runs/review-queue.json

# Reuse only unexpired exact-evidence decisions, deterministically reject obvious non-fits,
# and invoke the reviewer for the remaining bounded queue.
node find-candidates.mjs qualify --lake candidate_lake.sqlite \
  --queue runs/review-queue.json --profile node --count 25 \
  --out runs/qualifications.json
```

The lake case-normalizes candidate keys while retaining display casing, the complete imported
qualification JSON, and provenance. Mechanical refreshes update the issue row without changing old
review rows. An ACCEPT or REJECT is reusable only when its evidence digest, executor profile, and
expiry all match. Qualify binds the queued evidence key into the reviewer invocation; the reviewer
recomputes it from independently observed live facts and refuses drift before a verdict can be
stored.

Node is the default existing profile. Python, Go, and Rust are explicit pilot profiles with pinned
versioned images and profile-specific install, test, and cache conventions. Their registry entries
are deliberately marked as not production-proven.

When several profiles are requested in one crawl, each repository is assigned exactly one profile
before its candidate rows are persisted. An approved repository-policy override wins, followed by
the repository's primary language and then stable registry order. Explicit single-profile operation
is unchanged, and a later profile pass cannot overwrite an already assigned candidate.

The finder writes:

```text
runs/candidate-batch-<timestamp>.json
runs/candidate-batch-<timestamp>.audit.jsonl
runs/candidate-history-v2.jsonl
```

The JSON batch is also printed to stdout.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Requested batch completed, or `--dry-run` completed |
| `2` | Valid partial batch; budget or eligible review queue was exhausted |
| `1` | Finder infrastructure or configuration failure |

A partial batch is an intentional finite result. It is not permission to rerun the same candidates
with a deeper review. Run a new search later or change the explicitly versioned search policy.

## Default hard bounds

| Control | Default |
|---|---:|
| Whole finder run | 20 minutes |
| One semantic review | 5 minutes |
| Concurrent semantic reviews | 4 |
| Semantic reviews | `min(40, max(12, requested × 4))` |
| REST results per search stratum | 100 maximum |
| Candidates mechanically hydrated | `min(200, max(60, requested × 8))` |
| Issue comments | 30 risk-signal threshold; never a sole rejection |
| Cross-reference events | 50 maximum |
| Repository inactivity | 180 days maximum |
| Selected issues per repository | 1 |
| Selected issues per owner | 2 |
| Qualification TTL | 2 hours |
| GitHub/tool transient retries | 1, inside the original deadline |
| Semantic-review retries | 0 |

The wall-clock budget never resets when a transient GitHub retry occurs.

## Discovery policy

Default discovery uses exact `good first issue` and `help wanted` labels, open issues, no assignee,
public non-archived repositories, a ten-star floor, and Node-oriented JavaScript/TypeScript strata.
An explicit profile selects the corresponding registry languages. Targeted repositories can add
repository-approved invitation labels through `repo-policy.json`; label enumeration and search
pagination stay bounded. A custom label is carried with the complete policy snapshot and its digest
through crawl, rank, qualify, and reviewer validation; it qualifies only while the live issue still
has that exact normalized label and the policy evidence remains content-identical.
The star floor is enforced during repository preflight; it is deliberately not placed in GitHub's
issue-search query because issue search does not support the repository `stars:` qualifier.
The exact query plan and its hash are stored in every report.

GitHub search is read through the REST response rather than only through formatted CLI output. The
finder fails closed if GitHub returns `incomplete_results: true` twice. It also records whether a
stratum was intentionally truncated at the configured result cap. Optional created/updated windows
produce deterministic, non-overlapping search shards.

Use `--labels`, `--terms`, or `--repos` only as explicit policy changes. The semantic reviewer still
must prove every mandatory gate.

## Mechanical preflight gates

A candidate is rejected before model review when any of these applies:

- previously reviewed or present in an exclusion register;
- repository cooldown;
- the repository's policy-driven Northset open-PR or daily-PR cap is reached (both default to one);
- repository is private, archived, a fork, stale, or below the star floor;
- issue is closed, locked, assigned, or lacks a qualifying invitation label;
- issue has more than 50 cross-reference events;
- open same-repository PR is cross-referenced;
- a recent explicit contributor claim is present;
- recent comments show unresolved design disagreement, or related implementation attempts are
  excessive;
- task is security, bounty, dependency, translation, docs-only, migration, performance,
  concurrency, broad proposal/design, or another class outside the current Tier A lane;
- deterministic score falls below the configured threshold.

Mechanical scoring only orders the queue. It can never turn a semantic rejection into an accept.

## One-review invariant

In the original numeric workflow, immediately before launching `review-issue.mjs`, the finder
appends `review_started` to the history file. A candidate becomes permanently seen only after a
conclusive semantic disposition. In the lake-backed workflow, a deterministic no-model reject may
finish a clearly unsuitable candidate before the expensive reviewer. Interrupted starts, timeouts,
output limits, invalid reviewer output, and reviewer-tool failures remain retryable because none is
a semantic candidate judgment.

The absence of a preseeded repository test command is not a deterministic rejection. The bounded
reviewer already clones and inspects the current source and may derive the exact deterministic
harness; if it cannot establish one, it must reject, and every ACCEPT still carries that command.

An `ACCEPT` is valid only when:

- reviewer process exits `0`;
- verdict is `ACCEPT`;
- every reviewer check is `PASS`;
- tier is `A`;
- executor profile matches the requested profile;
- full base commit and exact test command are present;
- source, invitation, and acceptance-contract evidence are present;
- reviewer base commit equals the mechanically observed default-branch head;
- reviewer issue URL equals the preflight issue URL.

Each accepted qualification receives a content-derived `review_id`, `evidence_sha256`, and expiry.

## Audit and recovery

The append-only history records every review start and terminal attempt, including retryable
infrastructure failures, without treating those failures as semantic rejections.
A process lock prevents two finders from reviewing the same history concurrently. A stale lock is
recovered only when it is old and its local PID is no longer alive.

The batch JSON and audit JSONL are written atomically. The lake uses SQLite WAL durability and
preserves imported rich review JSON rather than flattening its evidence. The audit contains search
counts, rate-limit checks, every mechanical disposition, review starts, review terminal states, and
final batch state.

## Recommended production invocation

Keep the defaults for the first ten runs:

```sh
node find-candidates.mjs 5
```

Track these across runs before changing thresholds:

- accepted candidates per semantic review;
- rejection counts by mechanical reason;
- semantic-review timeout rate;
- complete versus partial batches;
- median and p95 review duration;
- later `prepare` stale/no-change/oracle failure rates by finder score band.

Change one threshold at a time and version the finder when a policy change affects which candidates
can be selected.
