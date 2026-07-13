# OSS Mission Orchestrator

Private tool (never pushed public) for Northset's OSS contribute-first loop. Discovery and screening
stay as separate founder tools; `oss.mjs` is the one canonical prepare/ship CLI, `core.mjs` holds its
shared logic, and `oss.test.mjs` is its one test suite.

## Find the next candidate batch

```sh
node find-candidates.mjs 10
```

Replace `10` with the number of accepted candidates you want. The finder searches current,
unassigned `good first issue` and `help wanted` issues in public repositories with at least 10
stars, skips
the candidates in Northset's first two registers and anything it reviewed previously, and runs
`review-issue.mjs` on the remainder. It uses four reviewers in parallel by default.

The completed JSON batch is printed to stdout and saved under `runs/candidate-batch-*.json`.
Review history is kept in the ignored local file `runs/candidate-history.jsonl`, so the next run
moves on instead of repeating work. Exit `0` means all `N` candidates were found, exit `2` means
the search produced a smaller partial batch, and exit `1` means the finder itself failed. It only
reads GitHub and makes temporary clones; it does not claim issues or change repositories.

For an unusually small or large run, `OSS_FIND_CONCURRENCY` changes parallelism and
`OSS_FIND_MAX_REVIEWS` caps how many issues may be inspected. Normally neither is needed.

## Review one candidate

Before writing a mission spec, run the standalone conservative reviewer:

```sh
node review-issue.mjs https://github.com/owner/repo/issues/123
# or: node review-issue.mjs owner/repo#123
```

It gathers the live issue, comments, timeline and PR references, clones the current default branch
to a temporary directory, and asks a read-only Codex review to inspect current source, test seams and
repository contribution instructions. It never installs dependencies, runs repository code, or
changes GitHub. Output is one JSON verdict; exit `0` means `ACCEPT`, exit `2` means `REJECT`, and exit
`1` means the review itself failed. Uncertainty is always `REJECT`.

`ACCEPT` is candidate triage, not permission to claim or submit work. Re-run it immediately before
starting a mission. The default model is `gpt-5.6-sol`; override only if needed with
`OSS_REVIEW_MODEL` and `OSS_REVIEW_EFFORT`.

## Canonical flow

1. Discover a batch with `find-candidates.mjs`, then screen each candidate with
   `review-issue.mjs`. Only an `ACCEPT` becomes a mission spec.
2. Prepare one mission:

   ```sh
   node oss.mjs prepare --only M-014
   ```

   Prepare performs the fail-closed live recheck, runs the fix in the hardened networked author
   container, applies only its committed patch to a fresh clean base on the trusted host, and runs
   the spec-pinned check in the network-off verifier. It prints a `READY` board with the receipt,
   flagged file classes, manifest digest, and ready-pack paths. Use `--dry-run` to print the planned
   board without authoring or verification.
3. Review the ready-pack once: the exact diff and commit, receipt subject, flagged file classes, PR
   title/body, repository, and planned actions are bound by the printed manifest digest.
4. Ship exactly that reviewed pack:

   ```sh
   node oss.mjs ship --approve <manifest-digest> M-014
   ```

   Ship builds the attestable receipt with `northset-oss`, publishes and verifies the public ledger
   record, pushes the exact reviewed commit to the fork, opens the PR, asserts its head OID and stored
   footer, and records progress in a resumable journal. No outbound step runs unless `--approve`
   exactly matches the ready-pack manifest.

> Volume never buys down review. If production outruns review, throttle production — not the gate.

## Load-bearing invariants (don't delete these)

- **Separated containers** — the author has network access and only the workspace plus throwaway
  Codex home mounted; the fresh verifier has `--network=none`, no credentials, and only runs the
  declared check against the clean base plus committed patch.
- **Recheck fail-closed + timeline scan** (`recheck`, `timelineCrossReferences`) — scans the issue
  timeline for prior **closed** competing PRs, not just open ones, and a failed timeline fetch is
  FAILED, never a silent "0 PRs = clean". The A-003 lesson: prettier#19588 had an identical PR
  #19589 closed the day before; an open-PR-only check read "clean" and we shipped a duplicate a core
  maintainer closed in 30 min. Apply the timeline check to every candidate, including clean-looking ones.
- **Content-bound approval** — canonical manifest serialization binds everything that will ship;
  `--approve` must match exactly, and pushed/PR-head OIDs must equal the reviewed commit.
- **Mandatory receipt footer** (`RECEIPT_FOOTER`) — every PR body carries the Northset
  receipt-disclosure footer (the verification-pilot link is the visibility mechanism). Single
  enforcement point; never drop it. Dropping it is why M-011 needed hand rework.
- **OSS identity + DCO** — every author commit is fail-closed checked for the canonical OSS author
  and committer identity and exact `Signed-off-by` trailer.
- **`--require-success`** is passed unconditionally to the receipt build.

Run the canonical suite with `node --test oss.test.mjs`.

## Spec format

One JSON per mission in `specs/` (see `specs/M-010.example.json`):
`mission_id, candidate (owner/repo#N), target_repo, issue_url, base_commit (40-hex),
code_prompt, executor{image, install_commands[], commands[], limits{}}, receipt{}`.

## Dependencies (verified real)

- `/Users/aeziz-local/northset-oss/bin/run-mission.mjs` — the receipt pipeline (2-phase Docker:
  phaseA networked install, phaseB `--network=none` verify), bundle + ledger. This is the
  verification product; the orchestrator calls it only during approved ship.
- `codex` CLI (`gpt-5.6-sol`, xhigh, fast) — the executor. `gh` authed as AysajanE. Docker + node 22.
- OSS commit identity is `aeziz@northset.ai`, set per-clone, never global.
