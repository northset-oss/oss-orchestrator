# OSS Mission Orchestrator

Private tool (never pushed public) that runs Northset's OSS contribute-first loop for many
candidate issues in parallel, then **stops at your review gate**. It never pushes, forks, attests,
or opens a PR — that stays the proven manual M-008/M-009 flow.

Everything lives in one file: **`runner.mjs`** (+ `runner.test.mjs`). That is the whole tool.

## The two passes (this is the design)

The expensive, fragile part of a mission is the Dockerized attested-receipt build (`npm install` +
tests + bundle + ledger, uncached, minutes each). Building it on *every* candidate before you've
read the diff is why a fix took 10+ minutes. So the loop is split at your review gate:

```
# PASS 1 — SCAN (fast, no Docker; run this across all your candidates)
node runner.mjs [--only M-010] [--concurrency 4] [--specs specs] [--out runs]
#   per mission: recheck (issue timeline) -> clone at base_commit -> Codex codes in an
#   isolated clone -> capture diff + PR body -> STOP.  Result per mission:
#     CODED     Codex produced a diff — review runs/<id>/fix.patch
#     NOCHANGE  tree left unmodified (issue already fixed on main — not a failure)
#     SKIP      recheck not clean (closed / assigned / competing PR)
#     FAILED    a real error (see runs/<id>/run.log)

# --- you read each CODED diff and decide what to ship ---

# PASS 2 — RECEIPT (heavy; run ONLY on the fixes you approve)
node runner.mjs --receipt --only M-010 [--specs specs] [--out runs]
#   asserts the work tree still equals the exact commit you reviewed (head==tested),
#   rechecks the issue again, builds the attested receipt locally, prints the manual ship.

# recheck a mission without coding (used inside the manual ship checklist)
node runner.mjs --recheck-only --only M-010
```

Docker cost is now paid only on winners. Scanning is Codex-bound, so raise `--concurrency` toward
your Codex rate limit to scan more at once.

## What stays manual, and why

The runner never performs an irreversible or public act. After PASS 2 it prints the exact
M-008/M-009 ship commands; **you** run them: push the receipt to northset-oss + attest, push the
fork branch, open the PR. Every outbound PR is reviewed line-by-line and authorized by the founder.

> Volume never buys down review. If production outruns review, throttle production — not the gate.

## Load-bearing invariants (don't delete these)

- **Isolated Codex sandbox** (`codexConfigText`, `createCodexHome`, `codexEnv`) — Codex runs untrusted
  OSS code under a throwaway `CODEX_HOME`, filtered env (no host secrets), workspace-only filesystem,
  network off. Founder decision: re-confined on purpose.
- **Recheck fail-closed + timeline scan** (`recheck`, `timelineCrossReferences`) — scans the issue
  timeline for prior **closed** competing PRs, not just open ones, and a failed timeline fetch is
  FAILED, never a silent "0 PRs = clean". The A-003 lesson: prettier#19588 had an identical PR
  #19589 closed the day before; an open-PR-only check read "clean" and we shipped a duplicate a core
  maintainer closed in 30 min. Apply the timeline check to every candidate, including clean-looking ones.
- **head==tested** — PASS 2 refuses to build a receipt for a tree that drifted from the reviewed
  commit (`mission.json` pins `patch_commit`/`patch_diff_hash` at scan time).
- **Mandatory receipt footer** (`RECEIPT_FOOTER`) — every PR body carries the Northset
  receipt-disclosure footer (the verification-pilot link is the visibility mechanism). Single
  enforcement point; never drop it. Dropping it is why M-011 needed hand rework.
- **Commit-pinned ship** (`manualShipLines`) — pins the exact commit and rechecks twice (before push,
  before PR open). Never rebase at push; push the exact bound commit.
- **`--require-success`** is passed unconditionally to the receipt build.

These are all covered by `runner.test.mjs` — run `node --test runner.test.mjs`.

## Spec format

One JSON per mission in `specs/` (see `specs/M-010.example.json`):
`mission_id, candidate (owner/repo#N), target_repo, issue_url, base_commit (40-hex),
code_prompt, executor{image, install_commands[], commands[], limits{}}, receipt{}`.

## Dependencies (verified real)

- `/Users/aeziz-local/northset-oss/bin/run-mission.mjs` — the receipt pipeline (2-phase Docker:
  phaseA networked install, phaseB `--network=none` verify), bundle + ledger. This is the
  verification product; the orchestrator only calls it in PASS 2.
- `codex` CLI (`gpt-5.6-sol`, xhigh, fast) — the executor. `gh` authed as AysajanE. Docker + node 22.
- OSS commit identity is `aeziz@northset.ai`, set per-clone, never global.

## Deferred (not built, on purpose)

Auto push/fork/attest/PR, fork auto-delete, a dual-vendor adversarial layer per mission, a durable
ship-transaction journal, and a scheduler/lock. Earlier design drafts specified these; none are
built. Add them only if the manual ship becomes the bottleneck — today the human gate is the point.
