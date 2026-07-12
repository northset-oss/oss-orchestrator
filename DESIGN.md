# OSS Mission Orchestrator — Design Spec (v0, for adversarial review)

**Purpose.** Run the Northset OSS contribute-first loop at 3→5→(cautious)10 parallelism while
preserving quality absolutely: **every Codex diff is reviewed by the owner; every outbound PR is
authorized by the founder.** Resumable across Codex-quota pauses and session boundaries.
Automated gates + an adversarial pre-review layer carry the quality load so human review scales.

**Non-negotiables (the whole point of the system).**
- No mission reaches an outbound action (PR open, or northset-oss push/attest) without (a) the
  owner having reviewed the diff and (b) the founder having authorized that specific PR.
- Volume never buys down review. If produced-diffs outrun careful review, the system *throttles
  production*, it does not rush review.
- A failing quality gate BLOCKS; it never warns-and-proceeds.

---

## 1. Components

1. **Mission board** — `board.json`, the single source of truth. One record per candidate.
2. **Stage runners** — pure functions advancing a mission one stage; each idempotent + resumable.
3. **Scheduler** — picks ready missions, respects concurrency caps + serial locks, runs stages.
4. **Adversarial review layer** — per-diff skeptics (Claude adversary + Codex critique), redacted.
5. **PR sync + fork cleanup** — flag-only monitor; deletes forks only at terminal status.

## 2. Mission record (board.json)

```
{
  "candidate": "prettier/prettier#19588",
  "mission_id": "M-009",              // assigned at spec time; monotonic, never reused
  "reasoning": "xhigh",               // owner sets: high|xhigh by complexity
  "workspace": "/Users/.../oss-missions/M-009-...",
  "stage": "reviewed",                // see state machine §3
  "stage_history": [{"stage":"...","at":"<iso>"}],
  "artifacts": {
    "base_commit": "...", "head_commit": "...", "patch_diff_hash": "sha256:...",
    "receipt_bundle_digest": "sha256:...", "fork": "AysajanE/prettier",
    "pr_url": null, "pr_head_verified": false, "changelog_pr_guess": null
  },
  "adv_findings": [ ... ],            // skeptic outputs, attached at adv_review
  "blocker": null,                    // e.g. "codex_quota", "docker_capacity"
  "last_error": null,
  "terminal_reason": null             // for skipped/rejected/held/failed
}
```
Board writes are atomic (write temp + rename) and guarded by a single-writer lock; the scheduler
is the only writer. The board is committed to git after every transition (audit + crash recovery).

## 3. State machine (stages + who runs them)

```
queued
  └─(recheck: parallel, read-only)──► rechecked ──► skipped(terminal: closed/assigned/claimed/fixed/unsafe)
rechecked
  └─(spec: OWNER, serial, unrushed)──► specced
specced
  └─(code: Codex via codex_implement.sh, PARALLEL≤C, isolated worktree)──► coded
       └─ on quota error ──► blocker=codex_quota (auto-retry after reset)
coded
  └─(verify: containerized red→green+lint, PARALLEL≤D)──► verified
       └─ on fail ──► back to specced (≤2 fix rounds) else rejected_inline(terminal)
verified
  └─(adversarial review: Claude adversary [+ Codex critique for xhigh], PARALLEL)──► adv_reviewed
adv_reviewed
  └─(OWNER review: SERIAL, the quality gate)──► reviewed | rejected_inline | back-to-specced
reviewed
  └─(receipt: pipeline, SERIAL on northset-oss)──► receipted
receipted
  └─(gate: BATCHED to founder)──► authorized | held(pausable)
authorized
  └─(push: SERIAL, one-mission-per-push)──► shipped(terminal)
       steps: commit+push receipt→attest→verify attestation→fork→push branch→
              FINAL recheck→open PR→verify head==tested→ledger row
```
Terminal states: `shipped`, `skipped`, `rejected_inline`, `failed`. `held` is pausable (re-enters
at gate). Every non-terminal stage is idempotent: re-running detects prior partial work and
resumes (e.g. verify checks if commits already exist; push checks if the receipt is already
attested / the PR already open).

## 4. Concurrency & resource model

- `C` = code+adv concurrency cap (start 3, ramp 5, cautious 10). Bounds concurrent Codex runs.
- `D` = Docker concurrency cap for verify+receipt. Each container uses ~4 cpu / 4–6 GB.
  `D = min(C, floor((cores-2)/perBuildCpu))`. At high C, lower per-build cpu (e.g. 2) rather than
  starve the host. Verify and receipt share the Docker budget.
- **Serial locks:** (a) `spec` (owner, one at a time by nature), (b) `receipt` + `push` share a
  single **northset-oss lock** (shared index.json/site + one-mission-per-push attest constraint).
- Codex quota: on `-429`/limit, mission → `blocker=codex_quota`; scheduler backs off + retries
  after a configurable reset window; never spins.

## 5. Safety invariants (asserted in code, not prose)

- **INV-1 no-unreviewed-outbound:** `push` stage refuses unless `stage_history` contains both
  `reviewed` (owner) and `authorized` (founder). Hard assert.
- **INV-2 head==tested:** before linking receipt / after PR open, assert
  `pr_head == artifacts.head_commit == receipt.patch_commit`; abort on mismatch.
- **INV-3 final-recheck:** immediately before PR open, re-query issue open/unassigned/no-competing-PR;
  fail → `skipped`, nothing pushed.
- **INV-4 one-mission-per-push:** northset-oss lock serializes; each push adds exactly one mission
  bundle (assert HEAD~1 diff touches one `missions/*/bundle/**`).
- **INV-5 isolated-worktrees:** each Codex run in its own clone; assert no two share a tree.
- **INV-6 atomic-board:** temp-write+rename+flock; scheduler single-writer.
- **INV-7 irreversible-gated:** fork DELETE and PR OPEN require explicit mode; fork-delete only at
  terminal + only for forks with zero open PRs; both default flag/dry-run.
- **INV-8 hard-gates:** red-first, green, no-snapshot/-artifact churn, lint clean, code-binding
  (source==base, patch==declared), bundle-verify, parity, leak-grep — ALL must pass to advance;
  any fail blocks.
- **INV-9 resumable:** every stage idempotent; board is recovery point; a killed run loses at most
  the in-flight stage, never corrupts committed state.
- **INV-10 no-secrets-in-logs:** board/logs redact tokens; receipts already leak-grepped.

## 6. Adversarial review layer

For each `verified` mission, BEFORE owner review:
- **Claude adversary** (adversary-claude subagent): handed the diff + frozen spec + verify output
  (NOT the owner's opinion). Prompt: refute the fix — correctness holes, over/under-escaping,
  untested edges, style/CI failures, scope creep. Default to finding problems.
- **Codex critique** (codex_critique.sh, xhigh) for `xhigh`-class missions (cross-vendor).
- Findings attach to the record. Owner review consumes them (review the survivors + findings),
  which is faster + higher-signal than cold-reading every line. **Augments, never replaces, owner
  review (INV-1 holds).** Skeptic disagreement the owner can't resolve → escalate to founder.

## 7. PR sync + fork cleanup (separate, flag-only)

- `pr-status-sync`: reads shipped missions' PRs, polls gh (state, mergedAt, mergeCommit, reviews,
  comments, checks), detects transitions, updates a JSON registry + rendered ledger. Classifies:
  merged→`MERGED_PR` win (+merge commit, update receipt maintainer_outcome, mark fork
  delete-eligible); closed-unmerged→rejected (+closing-comment cause); new comment/review→
  needs-attention. **Read-only on GitHub; flags, never auto-posts** (a "thanks"/CLA-nudge is
  outbound → surfaces to human). Cron 2×/day (tighter first 48h).
- `fork-cleanup`: deletes forks with zero open PRs at terminal status (needs `delete_repo` scope).
  Starts dry-run; auto-delete only after it demonstrably makes correct calls. Proven once live on a
  real terminal PR before trusting it.

## 8. Location & privacy

Lives in PRIVATE `/Users/aeziz-local/oss-orchestrator/` (git, never pushed public). Board + logs
name candidates/process → not for the public verification-pilot repo. Receipts still publish to
northset-oss as before.

## 9. Resume / failure model

Board = source of truth. On start: load board, resume each mission from its stage. Quota →
back-off+retry. Crash → last committed transition is recovery point. Serial locks prevent
double-push. Missions never silently half-complete: a mission stuck >T in a stage is surfaced.

## 10. Explicit open questions for the reviewers

1. Any path in §3 that reaches `pushing`/`shipped` skipping owner-review or founder-auth? (INV-1)
2. Concurrency races: board writes, northset-oss lock, worktrees, receipt/push serialization.
3. Idempotency/resume gaps: which stage, re-run mid-flight, double-acts or corrupts?
4. Is the adversarial layer real quality or theater? Does redaction actually happen?
5. Resource model realistic at C=10? Where does the host thrash?
6. Irreversible-op safety: can a bug delete a fork with an open PR, or open a PR twice?
7. Final-recheck (INV-3) timing vs. TOCTOU: gap between recheck and PR open.
8. Over-engineering: what should be cut for v1 (start-at-3) vs. deferred?
9. Failure modes not modeled (partial push, attest fails after receipt commit, PR opens but
   ledger write fails, fork push succeeds but PR create fails).
10. Where is quality most likely to silently degrade as N grows, and what tripwire catches it?
```
