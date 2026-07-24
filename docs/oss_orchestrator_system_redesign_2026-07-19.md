# Executive verdict

Your diagnosis is correct.

The current system is not primarily suffering from weak hardware, insufficient concurrency, or a lack of candidates. It is suffering from **control-plane inversion**: a governance and research protocol has been compiled into the production runtime. The machinery now spends enormous effort proving that it is allowed to begin work, preserving evidence about why it waited, and validating its own controls—while producing almost no READY work.

The previous reviews over-corrected toward completeness, auditability, and defense in depth. That was the wrong tradeoff at this stage. **I would stop executing Phase 1 as presently defined and replace its runtime contract immediately.**

The system should follow one rule:

> **Everything private, local, reversible, and non-public is fully autonomous. Only the irreversible public action—pushing and opening upstream PRs—requires one content-bound human batch approval.**

A second independent control should protect the GitHub account:

> **A tiny outbound safety governor controls GitHub mutations and stops on rate-limit, abuse, platform-warning, opt-out, or duplicate-work signals. It must not control local discovery, authoring, testing, or preparation.**

That is the redesign.

---

# 1. What the evidence says

The current snapshot makes the root cause unusually clear:

| Signal                                     | Current state | Meaning                                               |
| ------------------------------------------ | ------------: | ----------------------------------------------------- |
| Mechanically eligible issues               |         1,454 | Supply is not the immediate bottleneck                |
| Fresh repositories                         |         1,050 | Repository diversity exists                           |
| Available repository slots                 |         1,005 | Repo-cap availability exists                          |
| Candidates staged for the next window      |             4 | The control plane is starving the workers             |
| Python/Go candidates semantically reviewed |            88 | Considerable qualification effort                     |
| Accepted                                   |             5 | About 5.7% acceptance in that pilot sample            |
| Successful full dry prepares               |             0 | Qualification did not translate into execution        |
| Recorded failed preparation attempts       |            11 | The profile pilots are consuming the experiment       |
| READY items                                |             0 | No batch for the human owner                          |
| Completed boards                           |             2 | Boards ran despite having nothing to approve          |
| Authorized candidate claim comments        |             2 | Public/social budget spent before value was delivered |
| Orchestrator tests passing                 |           254 | Large control surface validated                       |
| Public executor tests passing              |           271 | Large verification surface validated                  |
| Shipped Python/Go receipts                 |             0 | Test completion is masking mission non-completion     |

The system had 1,454 eligible issues and 1,005 available slots, but staged only two Python and two Go candidates, scheduled qualification for a future clock time, scheduled preparation later, and scheduled a board approximately six hours after that. One prior board explicitly “closed on time with zero READY items and zero publication actions.”

This is not a capacity problem. It is not even primarily a candidate-quality problem. It is a **self-imposed flow-control problem**.

There is also an internal contradiction:

* The founder amendment says no separate Shehide technical identity or signing key is required.
* The runtime still reports that calibration ordinals 1–20 require two distinct reviewer signatures and that the second key remains pending.
* The adopted footer says the change was reviewed by Northset and Aysajan accepts responsibility.
* The implementation still emits: “AI assistance was used; I reviewed and own this change.”

The operating decision and executable policy have diverged.

## Code volume confirms the diagnosis

A static count of the attached source shows approximately:

* **18,386 lines of production `.mjs`**
* **10,793 lines of tests**
* roughly **12,300 production lines** across the critical candidate, gateway, prepare, review, ship, and ledger path
* roughly **5,480 additional production lines** under `campaign/phase0` and `campaign/phase1`

The largest production modules are approximately:

| Module                | Lines |
| --------------------- | ----: |
| `find-candidates.mjs` | 2,580 |
| `gh-gateway.mjs`      | 2,255 |
| `ship.mjs`            | 2,126 |
| `oss.mjs`             | 2,007 |
| `core.mjs`            | 1,201 |
| `review-issue.mjs`    |   955 |
| `candidate-lake.mjs`  |   847 |

A bounded OSS contribution factory should not require an approximately 12,000-line critical path before counting the public verifier itself.

The target should be **4,000–6,000 production lines on the active factory path**, with archival/reporting/security-research utilities outside it.

---

# 2. The central design mistake

The action plan mixed three fundamentally different categories and treated all of them as synchronous gates.

## Category A: actual hard safety invariants

These should remain blocking:

1. No GitHub secrets or host credentials inside untrusted author/test containers.
2. A clean verifier must confirm the approved patch passes the stated check.
3. Patch, commit, pushed branch, and PR head must bind to the same bytes.
4. The issue must still be open and unoccupied immediately before submission.
5. One human must approve the final batch of exact diffs and PR bodies.
6. A GitHub rate-limit, abuse, warning, or explicit maintainer stop signal must halt outbound publication.
7. A repository cooldown or open-PR cap must be honored.

These are the small safety kernel.

## Category B: useful integrity evidence

These should normally be recorded, but they should not create repeated approval stages:

* issue snapshot;
* verifier image digest;
* check output;
* DCO identity;
* changed-file classification;
* local retry history;
* receipt digest;
* reviewer/approver identity;
* repository contribution-policy summary.

One batch approval can bind all of them.

## Category C: research, reporting, and optimization metrics

These must **never block the production factory**:

* three consecutive qualifying 24-hour periods;
* trailing-50 first-pass yield;
* trailing-30 task conversion;
* reviewer calibration disagreement;
* cost attribution completeness;
* p75 repository lifetime;
* social cohort maturity;
* shift handoffs;
* NTP observations;
* profile graduation counts;
* backup rehearsals;
* corpus completeness;
* T+30 reporting readiness;
* critic-panel composition.

These belong in dashboards and post-hoc reports.

The current system has converted Category C into executable authorization.

---

# 3. Immediate decision: retire Phase 1 as a runtime state

Do not “finish Phase 1” under the present exit gate. The exit gate is not a useful production objective.

It contains self-referential requirements:

* It needs 50 attempts and 30 completed tasks to form quality samples.
* It has staged only four candidates.
* It requires Python and Go profile graduation while the production-proven Node lane is available.
* It requires future scheduled JIT windows before it will even try those candidates.
* Its acceptance rate in the active pilot is approximately 5.7%.
* It will not reach its own samples because its gate architecture prevents enough work from entering the pipeline.

Phase 1 should become a label in the report, not a state that the orchestrator enforces.

Replace it with:

```text
FACTORY_ACTIVE
  Local work runs continuously.

PUBLICATION_ACTIVE | PUBLICATION_PAUSED
  Only the GitHub-facing publisher can be paused.
```

That is enough.

---

# 4. The new operating principle: one-way-door authorization

The best simplification is to classify actions by reversibility.

## Fully autonomous

AI agents should perform all of these continuously:

* discovery;
* candidate ranking;
* live preflight;
* repository clone/mirror update;
* dependency setup;
* issue/source inspection;
* authoring;
* retries;
* test generation;
* base/patched verification;
* patch classification;
* PR title/body drafting;
* receipt generation;
* READY-queue creation;
* rebase/reverification of stale READY work;
* attestation retries;
* ledger rendering;
* status monitoring.

No human approval is needed because these actions are local or reversible.

## Human-approved once per batch

The human owner approves:

* exact diffs;
* exact PR titles and bodies;
* exact target repositories/issues;
* exact receipt claims;
* exact selected mission IDs.

One batch digest binds the complete selected set.

The owner can approve 10, 20, or 30 READY missions at once. The owner can approve a subset and reject the rest.

## Human intervention only on exception

Human intervention outside batch approval is limited to:

* clearing a GitHub secondary/abuse/platform hold;
* adjudicating an explicit maintainer complaint or opt-out;
* responding to substantive maintainer questions;
* approving a rare Red/exception task, if those are permitted at all.

No human shift, schedule, key ceremony, handoff, or review-duration model belongs in the runtime.

---

# 5. Delete, preserve, and move off the critical path

## Preserve as hard invariants

| Existing feature                                     | Decision            |
| ---------------------------------------------------- | ------------------- |
| Credential-free dependency bootstrap                 | Keep                |
| No host secrets in author/verifier                   | Keep                |
| Disposable author container                          | Keep                |
| Clean verifier environment                           | Keep                |
| Network-off final check                              | Keep                |
| DCO identity                                         | Keep                |
| Patch → tree → commit → pushed OID → PR-head binding | Keep                |
| Changed-file classification                          | Keep, simplify      |
| Deterministic patch/claim linter                     | Keep                |
| Final duplicate/collision recheck                    | Keep                |
| One open PR per repository                           | Keep                |
| Repository cooldowns                                 | Keep                |
| Content-bound batch approval                         | Keep                |
| Idempotent publication journal                       | Keep, reduce states |
| Honest contributor self-run disclaimer               | Keep                |
| Immediate GitHub throttle/abuse stop                 | Keep                |

## Remove from the production path now

| Current component                                                     | Action                        |
| --------------------------------------------------------------------- | ----------------------------- |
| `campaign/phase1/runtime-guard.mjs` schedule enforcement              | Remove                        |
| `campaign/phase1/schedule.mjs` runtime use                            | Remove                        |
| Fixed shift and board times                                           | Remove                        |
| Six-hour prepare window                                               | Remove                        |
| Ninety-minute JIT qualification window                                | Remove                        |
| NTP-based qualification/preparation holds                             | Remove                        |
| Signed shift handoffs                                                 | Remove                        |
| Dual-review calibration as a ship gate                                | Remove                        |
| Per-mission reviewer signatures                                       | Remove                        |
| Five-percent Green dual-review audit as a ship gate                   | Remove                        |
| Disagreement hash-chain and founder adjudication state machine        | Remove from runtime           |
| Separate semantic candidate reviewer on every candidate               | Remove from normal lane       |
| `spec-finalize.mjs` as a manual intermediary                          | Remove from normal lane       |
| New mission ID for each failed local attempt                          | Remove                        |
| Two-hour semantic qualification expiry                                | Remove                        |
| Eight-hour READY expiry                                               | Remove                        |
| Claim comments before work                                            | Remove by default             |
| `test_only_then_fix` as a normal author mode                          | Remove from default path      |
| Cost-attribution completeness gate                                    | Remove                        |
| Python and Go graduation as Node-lane blockers                        | Remove                        |
| Phase-1 24-hour outcome gates                                         | Remove                        |
| Daily GitHub AIMD request budget                                      | Remove                        |
| Search-wave budget ceremonies                                         | Remove                        |
| Peer-path identity digests and repair ceremonies                      | Remove                        |
| Triple throttle persistence across gateway/resource/campaign controls | Replace with one pause record |
| Prepared ledger PR before upstream PR                                 | Remove                        |
| Waiting for ledger checks before upstream PR                          | Remove                        |
| Waiting for GitHub attestation before upstream PR                     | Remove                        |
| Waiting for Pages HTTP 200 before upstream PR                         | Remove                        |
| Final-envelope ledger PR as a ship-success condition                  | Remove                        |

## Keep as asynchronous utilities

These may remain in the repository but must not be imported by the production factory:

* source sealing and backups;
* image archival and SBOM generation;
* economic attribution;
* corpus construction;
* outcome reporting;
* reviewer calibration research;
* Phase-0 rehearsal tooling;
* policy change monitor;
* critic-panel data;
* profile-graduation reports.

Move them under something such as:

```text
archive/campaign-v3/
research/
reporting/
maintenance/
```

They should read production records after the fact.

---

# 6. Replace the current system with an always-on factory

## Proposed active modules

```text
factory/
  db.mjs
  source.mjs
  worker.mjs
  verifier.mjs
  board.mjs
  publisher.mjs
  github-safety.mjs
  cli.mjs
```

The entire active system can remain small.

## Simplified state model

```text
DISCOVERED
  -> QUEUED
  -> WORKING
  -> VERIFIED
  -> READY
  -> APPROVED
  -> PR_OPENED
  -> RECEIPT_ATTESTED
```

Terminal or side states:

```text
SKIPPED
FAILED
REJECTED_BY_OWNER
PUBLICATION_PAUSED
SUPERSEDED
```

That is sufficient.

Do not maintain a public mission ID for every local failure. Use:

```text
task_id     = stable hash of owner/repo#issue
attempt_id  = local integer or UUID
mission_id  = assigned only after a verified result enters READY
```

Failed local attempts remain telemetry rows under the same task.

## Minimal database

A single SQLite database is enough:

```sql
tasks(
  task_id,
  candidate,
  repository,
  issue_number,
  profile,
  priority,
  state,
  base_oid,
  attempt_count,
  last_error,
  updated_at
)

attempts(
  attempt_id,
  task_id,
  started_at,
  finished_at,
  model,
  outcome,
  failure_class,
  duration_ms,
  patch_sha256,
  commit_oid,
  verification_json
)

ready_items(
  mission_id,
  task_id,
  manifest_sha256,
  risk_tier,
  ready_at,
  board_id
)

boards(
  board_id,
  board_digest,
  state,
  created_at,
  approved_at,
  approved_ids_json
)

publications(
  mission_id,
  branch,
  pushed_oid,
  pr_url,
  receipt_url,
  attestation_state,
  publication_state
)

repository_state(
  repository,
  open_northset_prs,
  cooldown_reason,
  cooldown_until,
  last_pr_at
)
```

No separate candidate-history JSONL lock, attempt lineage folders, approval archives, dual-review event chains, and multi-file control state are needed for ordinary operation.

---

# 7. Discovery and qualification redesign

## 7.1 Stop crawling now

The current lake already contains:

* 1,454 fresh mechanically eligible issues;
* 1,050 fresh repositories;
* 1,005 available slots.

Do not spend more GitHub requests refreshing the whole lake.

The current 48-hour global freshness policy causes the system to repay the hydration cost for thousands of candidates whether or not they will be used.

Replace it with:

```text
Discovery record TTL:
  7–14 days

Live preflight:
  only for candidates about to enter a worker

Ship recheck:
  immediately before push/PR creation
```

Refresh only the next:

```text
2 × active worker count
```

or, at most:

```text
4 × active worker count
```

This turns thousands of repeated API calls into tens.

GH Archive mining is a good supply source because it avoids GitHub API search entirely. Keep it.

## 7.2 Stop making Python and Go the current bottleneck

Node is marked production-proven. Python and Go are pilot profiles.

Run:

```text
Node:
  all normal production workers

Python:
  at most one canary worker

Go:
  paused until Node factory is producing consistently

Rust:
  off
```

The current requirement of 20 successful dry prepares and five shipped receipts for both Python and Go before completing Phase 1 should be deleted.

A simpler profile rule is:

```text
A new profile begins with one canary worker.
After three consecutive VERIFIED results across three repositories:
  allow two workers.
After ten clean VERIFIED results:
  treat it as ordinary capacity.
Any profile-specific integrity failure:
  return to one canary worker.
```

Profile experiments must never stop the proven lane.

## 7.3 Eliminate the mandatory five-minute xhigh semantic reviewer

The current reviewer:

* gathers issue data;
* gathers repository data;
* gathers timeline pages;
* lists up to 100 PRs;
* may hydrate up to eight related PRs;
* clones the repository;
* runs a five-minute xhigh model;
* validates path-and-line citations;
* validates every maintainer evidence URL;
* requires every related PR to be dispositioned;
* gives the result a two-hour lifetime.

This makes sense for a rare, high-value adjudication. It is the wrong front door for speculative local work.

In the active Python/Go sample it accepted five of 88 candidates. If that acceptance rate persisted, 750 accepted candidates would require approximately 13,200 semantic reviews. The precise rate will differ for Node, but the direction is decisive.

### Replace it with speculative execution

A local failed attempt has no maintainer impact. Therefore local execution can be used as the strongest qualification test.

Use:

```text
Mechanical preflight
  -> source scout
  -> author only if viable
```

The scout runs in the same repository checkout as the author.

Minimal scout output:

```json
{
  "decision": "GO | SKIP",
  "reason": "...",
  "test_command": "...",
  "target_files": ["..."],
  "estimated_risk": "GREEN | AMBER | RED"
}
```

Parameters:

```text
default scout effort: medium
scout cap: 45–90 seconds
```

For very high-ranked, clear defect issues, skip the scout and start the builder directly.

The old full reviewer remains available only for:

* ambiguous histories;
* unusual policy questions;
* Amber exception work;
* post-hoc audit samples.

## 7.4 Reduce GitHub evidence gathering

At work start, the hard mechanical check needs only:

* issue open;
* issue unassigned or assigned to Northset;
* invitation label/policy present;
* repository not archived/forked;
* no Northset open PR;
* no exact linked open PR;
* no recent explicit external claimant;
* current default-branch OID.

Fetch these for ten or twenty candidates in one GraphQL request.

Do not list every PR and hydrate semantic matches by default.

Use escalation:

```text
Exact issue-linked open PR found:
  SKIP

Timeline or title suggests ambiguous overlap:
  run one deeper overlap check

No signal:
  proceed
```

## 7.5 Separate stable semantics from live state

The current evidence key combines:

* base commit;
* issue update timestamp;
* label state;
* assignee state;
* comment-tail hash;
* timeline-PR hash;
* repository-policy hash.

A harmless new comment invalidates the entire semantic decision.

Instead:

```text
semantic_key:
  issue body hash
  repository policy hash
  profile
  relevant source-tree signature

live_state:
  issue state
  assignees
  labels
  exact open PRs
  claimant signals
  current head
```

Stable semantic analysis can remain cached for days. Live state is cheaply rechecked at work start and submission.

A qualification should not expire merely because two hours passed.

---

# 8. Candidate ranking should optimize READY per minute

The current score mostly estimates whether an issue looks respectable. It does not learn which issues the factory can actually convert.

Use the attempt history to optimize:

```text
expected READY value
--------------------
expected lane minutes
```

Features already available include:

* profile/language;
* package manager;
* lockfile;
* monorepo signal;
* native dependency signal;
* repository size;
* test command type;
* issue comments;
* maintainer author association;
* reproduction terms;
* expected/actual examples;
* focused test seam;
* modified-test requirement;
* prior bootstrap success in that repository;
* prior Northset success in that toolchain;
* average install/test duration.

A simple logistic model or even a weighted empirical score is enough:

```text
priority =
  predicted_probability_of_READY
  / predicted_total_minutes
```

Do not build a sophisticated ML service. Recompute weights periodically from SQLite.

The factory’s target is not “most semantically pure issue.” It is:

> **Highest expected number of good, maintainer-relevant READY patches per unit of machine and model time.**

---

# 9. Execution redesign

## 9.1 One agent loop, not review → test-only author → fix author

The current system can run:

1. a separate semantic reviewer;
2. a test-only author phase;
3. a base-red validation;
4. a fix-only author phase;
5. a later differential oracle;
6. a later canonical verifier.

That is too many representations of the same question.

Default author mode should be:

```text
direct_fix
```

One model invocation gets:

* issue snapshot;
* contribution constraints;
* current source;
* ability to run the focused check;
* instruction to stop and mark SKIP if the task is unsuitable.

Recommended model policy:

```text
First attempt:
  high effort
  8–10 minute cap

Second attempt:
  high or xhigh
  receives exact verifier failure
  8–10 minute cap

After second failed author/verifier attempt:
  SKIP in standard lane
```

An exception lane can remain, but it must not be the normal path.

## 9.2 Use stage-specific concurrency

The current `pool(...prepareMission)` approach gives one lane to an entire mission across:

* clone;
* dependency install;
* model work;
* test work;
* bundle generation.

That leaves resources idle whenever one stage is bottlenecked.

Use separate semaphores:

```text
preflight:
  16 lightweight jobs

clone/mirror:
  6–8 jobs

dependency bootstrap:
  2–3 jobs
  disk/network bound

model author:
  6–12 jobs
  subscription/provider bound

verifier:
  3–5 jobs
  CPU/memory bound

receipt/board:
  unbounded lightweight work
```

A task advances between queues. It does not occupy a full pipeline slot while waiting for another resource class.

## 9.3 Fix dependency caching

The current dependency cache key includes:

* candidate;
* task or mission identity;
* base commit.

That prevents reuse across different issues in the same repository even when the dependency graph is identical.

Change it to:

```text
repository node ID
profile
executor image digest
architecture
install-command digest
dependency-manifest digest
lockfile digest
trust domain
```

Remove:

```text
candidate
mission_id
base_commit
```

A base change should invalidate dependencies only when a dependency manifest or lockfile changes.

Include:

* `package.json`;
* `pyproject.toml`;
* `requirements*.txt`;
* `go.mod`;
* `Cargo.toml`;
* lockfiles.

## 9.4 Stop recursively copying and hashing dependency trees

The current code can:

* install dependencies;
* copy dependency trees into a pre-author snapshot;
* recursively digest them;
* copy them into the base-red verifier;
* digest the snapshot before and after copying;
* run a canonical verifier that receives install commands again.

For Node repositories, recursive `node_modules` copying and hashing can dominate the actual test.

Replace this with a frozen dependency material volume:

```text
1. Bootstrap container creates a named/content-keyed dependency volume.
2. Bootstrap exits.
3. The volume is mounted read-only in author and verifier containers.
4. Writable test caches go to /tmp or a dedicated ephemeral cache.
5. Receipt records:
     image digest
     dependency manifests and lockfile digests
     install command digest
     cache key
```

Do not hash millions of dependency files for every attempt. The lockfile, image, install command, and immutable read-only volume are the meaningful evidence.

For environments where a package manager requires repository-local dependency paths, mount the frozen directories at those exact paths.

## 9.5 One clean verifier, two observations

The minimum useful verifier is:

```text
A. Base observation
   Clean base + test-only delta, or existing failing check
   Expected nonzero for a regression claim

B. Patched observation
   Clean base + full approved patch
   Expected zero
```

The patched observation creates the receipt.

Do not run a separate patched differential check and then another full canonical patched verifier unless the declared command sets are genuinely different.

The canonical public verifier can remain the one patched verifier. Feed it the base-observation record rather than rerunning the same patched check elsewhere.

## 9.6 Support typed contribution receipts

The current differential-red requirement discards useful, invited work that does not represent a pre-existing behavioral failure.

Use separate claims:

### `regression_fix`

```text
New/modified regression fails on base.
Full patch passes.
```

### `existing_check_repair`

```text
Repository-declared existing check fails on base.
Full patch passes.
No new regression is required.
```

### `coverage_addition`

```text
New tests pass on base and patched code.
Receipt claims added coverage only.
It does not claim a runtime defect was fixed.
```

### `test_infrastructure_fix`

```text
Existing test infrastructure failure is reproduced and repaired.
```

This preserves honesty while expanding the candidate pool. Pure coverage work can be valuable when maintainers explicitly asked for it; it simply cannot be labeled a defect proof.

## 9.7 Relax stale handling

Do not terminally consume a mission because the default branch advanced.

Before authoring:

```text
fetch latest base
```

Before publication:

```text
fetch latest base
check issue/PR occupancy
attempt clean rebase or merge-tree
rerun verifier if bytes changed
```

If the patch rebases cleanly and passes, regenerate the READY manifest. If the bytes changed after human approval, return only that item to READY for reapproval.

Do not create a new mission ID merely because the base advanced.

---

# 10. Human review redesign

## 10.1 Event-driven board

The READY queue itself is the board source.

Trigger a board when any condition is true:

```text
ready_count >= 10
oldest_ready_age >= 20–30 minutes
owner manually requests board
ready_count >= configured maximum, such as 30
```

No shift time. No NTP. No six-hour window. No JIT qualification schedule.

The owner can review whenever ready work exists.

## 10.2 One card per mission

Each card should show only:

```text
Repository / issue
Why this issue is invited and unoccupied
One-paragraph change summary
Changed files and diffstat
Risk tier and warnings
Base observation
Patched observation
Exact declared checks
Exact PR title
Exact PR body
Receipt claim
Links to full diff and logs
```

Do not make the owner inspect evidence manifests, policy snapshots, signer records, or attempt-lineage structures unless opening the detail view.

## 10.3 Green, Amber, Red

### Green

* production source and new tests only;
* no dependency/lockfile/CI change;
* no public API;
* no existing test weakening;
* no security/concurrency/migration work;
* at most five files and 300 lines;
* checks pass;
* no claim-boundary warning.

Human action:

```text
Approve all Green
```

### Amber

* existing test modified;
* writable-copy verifier;
* unusual build;
* larger but still bounded patch;
* unclear repository convention.

Human action:

```text
inspect individually
```

### Red

* dependency changes;
* CI changes;
* security-sensitive work;
* public API expansion;
* migrations;
* release/version changes;
* generated output;
* broad design.

Scaled lane action:

```text
SKIP
```

No dual-review machinery is needed.

## 10.4 One batch approval

One record:

```json
{
  "batch_digest": "sha256:...",
  "approved_mission_ids": ["M-..."],
  "rejected_mission_ids": ["M-..."],
  "approved_by": "internal-user:aeziz",
  "approved_at": "..."
}
```

A local signature over the batch digest is optional. It is reasonable, but it must be one signature, not one per mission and not a reviewer-calibration state machine.

The batch digest binds:

* selected manifests;
* diffs;
* PR bodies;
* receipt claims;
* target repositories;
* exact planned public actions.

Any mutation invalidates only the affected item and requires a new approval for that item.

## 10.5 Correct the footer now

Change the implementation to the already adopted text:

> **AI assistance was used. This change was reviewed by Northset, and I accept responsibility for this submission.**

The current source still emits the old personal-review claim.

---

# 11. Publication is the largest removable latency block

The current ship order requires:

```text
push reviewed commit
prepared internal ledger PR
wait for internal checks
merge internal ledger PR
wait for attestation workflow
download attested release
verify attestation
wait for Pages
confirm each receipt returns HTTP 200
collision recheck
open upstream PR
sync disclosure
final internal ledger PR
wait for checks
merge final ledger PR
mark SHIPPED
```

This is a durable publication ceremony, not a fast ship path.

It can consume tens of minutes even when everything is healthy. Worse, upstream value is blocked on Northset’s own website, release, Pages, and ledger infrastructure.

## New publication order

```text
1. Validate approved bytes locally.
2. Final live issue/collision recheck.
3. Push exact approved commit to the fork.
4. Open upstream PR.
5. Read PR back; verify stored title, body, base, and head OID.
6. Mark SUBMITTED.
7. Publish/attest/reconcile receipt asynchronously.
```

## Preallocate a stable receipt URL

The PR body still needs a receipt link. Publish the immutable proof cheaply before opening the upstream PR.

Recommended model:

```text
northset-oss repository:
  append-only `receipts` branch

approved batch:
  one commit containing immutable proof.json files

push once:
  one batch push

receipt URL:
  canonical public ledger endpoint
```

The receipts branch remains the immutable evidence source, but it is not the contributor-facing
receipt URL. GitHub Pages validates and projects the current digest-bound proof at
`https://northset-oss.github.io/verification-pilot/receipts/<MISSION>/`. Immutable proof publication
provides that stable URL immediately. Pages rendering, machine-readable receipt projection,
attestation, and outcome updates reconcile asynchronously and never block an approved upstream PR.

Each proof has:

```text
proof.json
  immutable
  base
  patch
  commit/tree
  commands
  environment
  output hashes
  claim
  local/batch approval digest

publication.json
  mutable/asynchronous
  PR URL
  state
  CI result
  merge/closure outcome
  GitHub attestation
```

A Pages view can derive from those files later.

## Attestation should not block the PR

GitHub attestation remains useful, but it should be asynchronous:

```text
PR_OPENED:
  upstream value delivered

ATTESTATION_PENDING:
  background state

RECEIPT_ATTESTED:
  counted proof-of-pass receipt
```

The receipt count can still require attestation. Opening the PR does not need to wait for it.

If attestation fails:

* retry asynchronously;
* alert the operator;
* do not duplicate the upstream PR;
* leave the receipt clearly marked as attestation pending.

## Remove the two internal ledger PRs

For Northset’s own ledger repository, use:

* one direct append-only batch push to a dedicated branch; or
* one direct push to `main` after local verification; or
* one asynchronous ledger PR after upstream PRs have opened.

Do not place two Northset-owned PRs around every batch of third-party contributions.

A direct push to Northset’s own append-only receipt branch creates no maintainer-notification burden in third-party repositories and can be locally validated before push.

## New ship-success semantics

Use:

```text
SUBMITTED:
  upstream PR exists and its stored bytes/head are verified

RECEIPT_COMPLETE:
  immutable receipt is publicly available and attested

OUTCOME_RECORDED:
  later merge/closure/CI outcome reconciled
```

Do not make final envelope publication part of “submission success.”

---

# 12. Replace the 2,255-line GitHub gateway

The current gateway holds a global lock across:

* pacing delay;
* daily-budget read/write;
* wave-budget validation;
* gateway-state writes;
* the complete network request;
* rate-limit parsing;
* ledger append;
* throttle trip;
* multi-file peer-state persistence.

It also implements:

* daily additive/multiplicative request budgets;
* wave identities and immutable wave budgets;
* path-identity digests;
* stale-lock process identity;
* throttle marker digests;
* three-peer incident reconciliation;
* founder decision replay protection;
* clock repair;
* resume probes;
* migration and repair paths.

Yet the system still hit a GitHub secondary-rate-limit incident.

The lesson is not that it needs more state. The lesson is that it needs **fewer calls and a smaller queue**.

## A 250–400-line gateway is enough

Use one priority queue.

Priorities:

```text
1. Maintainer follow-up and corrections
2. Final submission rechecks and PR creation
3. Receipt/PR reconciliation
4. Candidate live preflight
5. Discovery top-up
```

Request behavior:

```text
REST/GraphQL reads:
  serial queue
  no artificial six-second delay
  use response headers
  use ETag/If-None-Match where useful

Search:
  serial
  approximately 2+ seconds between starts
  only as precision top-up

Mutations:
  serial
  at least 1–1.5 seconds between starts

PR creation:
  separately paced for account/community safety
```

GitHub recommends serial requests to reduce secondary-limit risk and at least a one-second pause between large numbers of mutative requests. It also recommends honoring `Retry-After`/reset headers, using conditional requests, webhooks instead of polling, and consolidated GraphQL queries. ([GitHub Docs][1])

## One pause file

```json
{
  "paused": true,
  "kind": "GITHUB_SECONDARY_RATE_LIMIT",
  "observed_at": "...",
  "retry_after": 120,
  "details": "...",
  "cleared_at": null,
  "cleared_by": null
}
```

That replaces gateway state, resource-control state, campaign-control state, and peer reconciliation for GitHub throttles.

### Resume policy

```text
Primary rate limit, remaining == 0:
  resume automatically after reset

Transient 5xx/network failure:
  one bounded retry

Secondary rate limit / Retry-After / abuse detection:
  stop all GitHub API requests
  wait at least the required interval
  require one owner resume action
  perform one rate-limit probe
  resume

GitHub warning or account restriction:
  no resume until founder/support review
```

GitHub explicitly warns that continuing to make requests while rate-limited may result in an integration ban. ([GitHub Docs][2])

## Do not poll `/rate_limit` continuously

GitHub says the endpoint itself can count toward secondary limits and recommends using response headers when possible. ([GitHub Docs][2])

Capture headers from ordinary requests. Use `/rate_limit` only for recovery probes or diagnostics.

---

# 13. GitHub-ban risk: the one place where speed must remain bounded

You are correct that the account is the critical external asset.

But that leads to an important distinction:

> **Local factory throughput and public PR throughput must be decoupled.**

The local factory can prepare 50, 100, or more verified patches per day. The publisher should release only at a rate that does not resemble disruptive automated bulk activity.

GitHub’s technical secondary ceilings include 100 concurrent requests, 900 REST points/minute, 2,000 GraphQL points/minute, and generally 80 content-generating requests/minute and 500/hour. Those are technical ceilings, not permission to create content at those rates. ([GitHub Docs][2])

GitHub’s AUP separately prohibits automated excessive bulk activity and use of the service for excessive automated activity. Its disruption policy specifically identifies empty or meaningless PRs, nonsensical reviews, excessive notifications, and other continually disruptive feature use as prohibited behavior for which GitHub may restrict accounts. ([GitHub Docs][3])

## The unavoidable conclusion

No software architecture can make **750–1,000 Northset-initiated upstream PRs in one week from one personal identity across unrelated repositories** categorically safe.

The patches can all be legitimate. The aggregate behavior can still look like excessive automated bulk activity and create an excessive notification burden.

Therefore:

* build the factory to prepare at 100+/day;
* do not promise that the public publisher can safely open 100+/day;
* seek GitHub Support guidance before the highest volume;
* expand maintainer-authorized verification and explicit opt-in lanes;
* favor repositories or organizations that explicitly welcome continued contributions;
* never solve the limit through account rotation or multiple identities.

## Minimal public-action governor

Starting defaults—not a GitHub safe harbor:

```text
max one open Northset PR per repository
max two new PRs per organization owner per day
max two to four new upstream PRs per hour
initial daily ceiling: 20–30
no pre-author claim comment unless repository policy requires it
no promotional follow-up
no repeated ping without maintainer engagement
```

Raise the public ceiling based on:

* GitHub Support response;
* absence of platform warnings;
* absence of spam/burden complaints;
* prompt maintainer follow-up;
* evidence that submitted PRs are substantive;
* explicit repository or organization invitations.

The factory continues preparing while the publisher is paced.

## Eliminate unnecessary claim comments

The recorded state shows two claim comments and zero successful pilot submissions.

Default policy should be:

```text
Do not post a claim comment.
```

Exceptions:

* repository explicitly requires a claim;
* maintainer asks contributors to announce work;
* assignment is necessary.

The final collision recheck is enough for ordinary issues.

This reduces public content, notifications, API mutations, and sunk social cost when preparation fails.

---

# 14. The immediate unblocking changes

These changes can be made before the larger refactor.

## 14.1 Disable schedule enforcement

Remove these calls from the active path:

```js
assertPhase1Runtime(... action: 'qualify')
assertPhase1Runtime(... action: 'prepare')
assertPhase1Runtime(... action: 'ship')
```

Or temporarily make the function enforce only:

```text
global GitHub publication hold
repository cooldown
```

It must not inspect:

* board time;
* shifts;
* NTP;
* predicted prepare start;
* qualified-ahead watermark.

The current function already returns inactive when no runtime file is supplied. Stop passing `--phase1-runtime` while the code is being removed.

## 14.2 Delete calibration requirements from shipment

Change the effective requirement to:

```text
Per-mission cryptographic reviewers:
  none

Human control:
  one batch approval
```

Remove:

* `calibration_ordinal`;
* two-reviewer requirement;
* Green five-percent dual-review gate;
* Amber dual-review gate;
* disagreement-rate pause;
* founder adjudication chain.

Amber remains visually highlighted in the board.

## 14.3 Run Node production now

Stop treating Python and Go as Phase-1 completion requirements.

Set:

```text
Node workers: 6–8
Python canary: 0 or 1
Go canary: 0
Rust: 0
```

Use the existing lake. Do not run another broad crawl.

## 14.4 Remove scheduled boards

Create a board whenever:

```text
10 READY exist
or
oldest READY is 30 minutes old
or
owner asks for a board
```

## 14.5 Extend or remove artificial expirations

Temporary legacy-path change:

```text
qualification lifetime:
  24 hours, with live recheck before work

READY lifetime:
  48–72 hours, with live recheck before ship
```

The replacement factory should not use wall-clock expiry as a terminal condition. It should use state drift.

## 14.6 Use `direct_fix`

Make this unconditional for the normal lane:

```json
{"authoring_mode":"direct_fix"}
```

Reserve test-only-first for selected tasks where the issue explicitly requires an added regression and the normal author has repeatedly produced an invalid oracle.

## 14.7 Repair the dependency cache key

Remove candidate/mission/base from `dependencyCacheKey`.

## 14.8 Correct the footer

Replace the stale implementation text immediately.

## 14.9 Stop Phase-1 outcome gates from blocking work

Continue calculating:

* first-attempt yield;
* task conversion;
* p95 duration;
* third-attempt share;
* cost attribution;
* profile results.

Do not call `blocked()` or refuse local work based on them.

---

# 15. Fast publisher transition

A complete ship rewrite can follow, but the first speed improvement is straightforward.

## Transitional path

Use the current prepared bundle, but change the order:

```text
validate batch approval
final collision recheck
push branches
open upstream PRs
verify stored PR heads/bodies
return SUBMITTED
```

Queue these afterward:

```text
prepared ledger publication
attestation
Pages
receipt HTTP check
disclosure reconciliation
final outcome envelope
```

No upstream PR should be held for a Northset-owned internal ledger check.

## Final path

Replace both ledger PRs with one append-only batch receipt push and asynchronous status updates.

---

# 16. Retry and failure policy

The current system creates too much ceremony around attempts.

Use:

## Infrastructure retry

```text
One automatic retry:
  Docker startup
  transient clone/fetch
  transient package registry
  transient local filesystem race

Same attempt record.
```

## Author retry

```text
First author or verifier failure:
  pass exact failure transcript to one second model attempt

Second failure:
  SKIP task in standard lane
```

## Exception lane

```text
Explicitly high-value task
At most one active
Never blocks standard workers
Every extra attempt records reason
Human approval is not needed until a READY result exists
```

No new mission JSON or mission ID is required for local retries.

---

# 17. New performance objectives

These are operational targets and alerts, not gates:

| Metric                                             |                                      Target |
| -------------------------------------------------- | ------------------------------------------: |
| Candidate selected → worker start                  |                             under 2 minutes |
| Worker start → READY p50                           |                         under 15–20 minutes |
| Worker start → READY p95                           |                            under 35 minutes |
| Model invocations per standard attempt             |                           1, occasionally 2 |
| Full dependency installations per dependency state |                                           1 |
| Patched verifier executions                        |                                           1 |
| Human approvals per 20 missions                    |                                           1 |
| READY threshold → board generation                 |                              under 1 minute |
| Owner approval → first eligible PR creation        | under 5 minutes, excluding publisher pacing |
| Governance/control CPU time                        |                                    under 5% |
| GitHub API calls per attempted candidate           |                 amortized low single digits |
| GitHub claim comments                              |                          approximately zero |
| Duplicate upstream PRs                             |                                        zero |
| Binding mismatches                                 |                                        zero |
| Throttle signal ignored                            |                                        zero |

The most important dashboard becomes:

```text
READY missions per lane-hour
```

Secondary metrics:

```text
READY per model invocation
READY per candidate
GitHub API calls per READY
human review seconds per READY
submission-to-maintainer-response backlog
```

---

# 18. Factory acceptance tests

Do not require another hundreds-test foundation program. Add a small set of end-to-end tests.

## Local factory

1. Fifty lake candidates enter a continuous queue.
2. No shift or board timestamp exists.
3. Multiple workers begin immediately.
4. Failed candidates do not consume public mission IDs.
5. Ten VERIFIED results automatically create a board.
6. Human can approve a subset.
7. A changed item invalidates only its own approval.

## Verifier

1. Base-red/patched-green regression.
2. Existing-check repair.
3. Coverage-only typed receipt.
4. Dependency volume is read-only after bootstrap.
5. Tracked-source mutation during final verification fails.
6. Patch/tree/commit binding mismatch fails.

## Publisher

1. Crash after pushing seven of twenty branches resumes without duplicates.
2. Crash after opening seven PRs adopts exact existing PRs.
3. Stale item is removed from the batch without stopping clean items.
4. Stored PR body/head mismatch fails that item.
5. Receipt attestation failure does not duplicate or close the upstream PR.
6. Final status publication failure leaves the upstream PR in a recoverable submitted state.

## GitHub safety

1. Secondary-rate-limit response stops all GitHub requests immediately.
2. `Retry-After` is honored.
3. Primary-rate reset resumes only after reset.
4. Mutation queue enforces spacing.
5. Repository cooldown rejects publication.
6. One-open-PR cap rejects publication.
7. Local author/verifier workers continue while publication is paused.

That last test is crucial.

---

# 19. Recommended new CLI

```sh
# Run the private factory continuously.
node factory/cli.mjs run \
  --profile node \
  --workers 8 \
  --board-size 20 \
  --board-max-age-minutes 30

# Display the current immutable board.
node factory/cli.mjs board

# Approve all Green items and selected Amber items.
node factory/cli.mjs approve \
  --board sha256:<digest> \
  --ids M-201,M-202,M-204

# Start or resume the paced public publisher.
node factory/cli.mjs publish \
  --board sha256:<digest>

# Inspect account-safety state.
node factory/cli.mjs github-status

# Clear a genuine secondary-limit hold after the required cooldown/probe.
node factory/cli.mjs github-resume \
  --reason "<founder decision>"
```

There is no:

* shift activation;
* JIT window;
* handoff;
* NTP gate;
* profile-exit gate;
* reviewer-calibration gate;
* scheduled board;
* per-mission signature command.

---

# 20. Revised action plan

## Stage A — Unblock production

* Disable runtime schedule gates.
* Stop broad discovery.
* Use the existing lake.
* Run Node only.
* Remove dual-review/calibration ship requirements.
* Use direct author mode.
* Generate boards on READY events.
* Approve in batches.
* Stop claim comments.
* Continue using the current verifier and shipper while the fast publisher is being cut in.

Success is:

```text
A real READY batch appears.
The owner approves it once.
Substantive upstream PRs open.
```

Not:

```text
Phase-1 metric samples become statistically mature.
```

## Stage B — Collapse the candidate and author path

* Demote `review-issue.mjs` to an exception/audit tool.
* Add scout/direct speculative execution.
* Generate minimal task records automatically.
* Assign public mission IDs at READY.
* fix dependency caching and frozen volumes;
* use stage-specific concurrency;
* support typed receipt variants.

## Stage C — Collapse publication

* Push one immutable receipt batch.
* Open upstream PRs immediately after approval and final recheck.
* Move attestation, Pages, and outcome envelopes to asynchronous workers.
* Replace the current ship state machine with the seven-state model.

## Stage D — Remove legacy runtime

After the new path has successfully:

* prepared;
* approved;
* submitted;
* resumed after a simulated crash;
* stopped on a simulated GitHub throttle;

move the old campaign runtime and its tests to an archival directory and remove all imports from production.

Do not spend weeks refactoring the existing knot one conditional at a time. A small parallel fast path is safer and quicker.

---

# 21. What should not be worked on now

Freeze all of the following until the authored Node factory is producing a reliable READY stream:

* Python profile graduation;
* Go profile graduation;
* Rust support;
* Northset Verify GitHub App;
* Marketplace;
* private-repository verification;
* microVM product infrastructure;
* cost-accounting completeness;
* published corpus;
* T+30 report;
* social-cohort statistics;
* critic panel;
* paid-pilot pricing;
* reviewer-calibration research;
* elaborate policy-monitor extensions.

None of those helps create the next READY patch.

---

# 22. Final judgment

The current system is salvageable, but the current operating contract is not.

The load-bearing insights to preserve are:

* local autonomous work;
* clean verification;
* exact byte binding;
* one batch human gate;
* final collision check;
* transparent receipt claim;
* repository respect;
* hard GitHub safety stop.

Everything else should either be deleted or moved off the synchronous path.

The single most important redesign is:

```text
PREPARE FAST AND CONTINUOUSLY
        ↓
READY QUEUE
        ↓
ONE HUMAN BATCH APPROVAL
        ↓
PACED, RECHECKED PR CREATION
        ↓
ASYNCHRONOUS RECEIPT/ATTESTATION/STATUS
```

And the single most important strategic correction is:

> **Build the factory for 100+ local verified results per day. Do not assume one personal GitHub identity can safely publish 100+ unsolicited or Northset-initiated PRs per day. Public throughput is governed by account and maintainer risk, not machine capacity.**

Stop waiting for the next shift, NTP observation, qualification window, board time, calibration key, or Phase-1 sample. Remove those controls from runtime, restart with the production-proven Node lane, and let the system do reversible work continuously.

[1]: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api "https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api"
[2]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api"
[3]: https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies "https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies"
# Historical design note — publication model superseded

This document records the July 19 design rationale. Its unconditional public-receipt flow,
Northset-branded footer, relationship/demand interpretation, and publication-rate assumptions were
superseded by incident policy v2 on July 23. They are not runtime authority and must not be restored.
Use `AGENTS.md` and `OPERATING_CONTRACT.md` for the active private-record, promotion-free,
publication-paused flow.
