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
`OSS_FIND_LABELS` accepts a comma-separated label list when an explicitly approved replacement
search needs to expand beyond the conservative `good first issue,help wanted` defaults. Expanded
discovery never relaxes `review-issue.mjs`; every candidate must still pass all nine gates.
`OSS_FIND_TERMS` accepts comma-separated high-signal phrases (for example `add tests,regression
test`) and searches those phrases instead of labels. It is intended for bounded replacement
research after the default invitation-label universe has been exhausted.
`OSS_FIND_STARS_MIN` raises the default 10-star repository floor for a higher-signal pass; it does
not affect any reviewer gate.
`OSS_FIND_REPOS` accepts a comma-separated `owner/repo` list and searches current unassigned issues
inside those repositories instead of the global label or phrase modes. Prior-register and history
exclusions still apply to exact issue keys.
`OSS_FIND_SEARCH_LIMIT` caps results fetched per label, phrase, or repository (maximum 1,000); use a
smaller value for multi-repository passes to stay within GitHub Search pagination limits.

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
   node oss.mjs prepare M-016
   ```

   Prepare rechecks invitation, maintainer intent, prior attempts, overlap, the one-open-PR cap and
   repository cooldown, plus any required pre-author notice; resolves the executor image to an immutable digest; bootstraps dependencies
   without credentials; runs the red/green author task; creates one host-owned DCO commit; proves
   the binary/full-index patch reproduces its tree; runs the base-fails/patch-passes oracle; and
   builds the final public bundle with `northset-oss`. It prints one `READY` review board.
3. Review the ready-pack once. The exact patch, commit/tree, issue and policy snapshots,
   differential-oracle record, public bundle digest, PR title/body, expiry and outbound actions are
   bound by the batch manifest digest.
4. Ship exactly that reviewed pack:

   ```sh
   node oss.mjs ship --approve <batch-manifest-digest> M-016
   ```

   Ship accepts one to three missions from distinct repositories. It checks the approval once,
   publishes the already-reviewed bundle, downloads and verifies the exact digest-qualified release
   asset and its GitHub attestation, pushes the reviewed commit, performs a final live recheck, opens
   the exact reviewed PR, and writes a mutable publication envelope. Progress is saved atomically in
   a manifest- and bundle-bound journal; corrupt or mismatched state is fatal.
5. Refresh factual upstream outcomes without editing immutable bundles:

   ```sh
   node oss.mjs status
   ```

> Volume never buys down review. If production outruns review, throttle production — not the gate.

## Load-bearing invariants (don't delete these)

- **Credentials enter only after dependency bootstrap** — the networked install phase has the
  public workspace and no Codex credential. The author gets a throwaway credential mount only after
  bootstrap. Public verification runs declared checks with `--network=none` and no credentials.
- **Recheck fail-closed + timeline scan** (`recheck`, `timelineCrossReferences`) — scans the issue
  timeline for prior **closed** competing PRs, not just open ones, and a failed timeline fetch is
  FAILED, never a silent "0 PRs = clean". The A-003 lesson: prettier#19588 had an identical PR
  #19589 closed the day before; an open-PR-only check read "clean" and we shipped a duplicate a core
  maintainer closed in 30 min. Apply the timeline check to every candidate, including clean-looking ones.
- **Content-bound approval** — canonical manifest serialization binds everything that will ship;
  `--approve` must match exactly, and pushed/PR-head OIDs must equal the reviewed commit.
- **Direct, neutral receipt footer** (`receiptFooter`) — every PR links directly to its mission
  anchor, discloses AI assistance, and describes only a contributor self-run record.
- **OSS identity + DCO** — every author commit is fail-closed checked for the canonical OSS author
  and committer identity and exact `Signed-off-by` trailer.
- **`--require-success`** is passed unconditionally to the receipt build.

Run the canonical suite with `node --test *.test.mjs`.

## Spec format

One JSON per mission in `specs/` (see `specs/M-010.example.json`). The author contract is
`problem_statement`, `acceptance_criteria[]`, `constraints[]`, and optional non-binding
`implementation_hints[]`; solution-prescriptive `code_prompt` is rejected. Every spec also binds
structured `qualification`, a differential `oracle`, exact `pr` copy, `base_branch`, `base_commit`,
`process_requirements[]`, and `executor{profile,image,install_commands[],commands[],limits{}}`.
Repository-policy invitations must use a blob URL pinned to `base_commit` plus a verified content
digest. If repository policy requires notice before work, the spec must bind the live issue-comment
evidence before `prepare` can start. `oracle.command` must name every newly added `oracle.test_paths`
entry as a single shell command, and both its defect-specific base failure (exact exit plus approved
output marker) and patched success are run and recorded. An optional
`pr.body_template` preserves upstream PR templates with only the documented placeholders. The initial production lane
accepts only the smoke-tested `node` profile and Tier A changes (source plus focused tests; no
dependency, lockfile, CI, build, container, generated, binary, symlink or submodule changes).

## Dependencies (verified real)

- `/Users/aeziz-local/northset-oss/bin/run-mission.mjs` — the only canonical verifier/bundle
  pipeline. Prepare calls it once; ship publishes those exact bytes and never rebuilds them.
- `codex` CLI (`gpt-5.6-sol`, xhigh, fast) — the executor. `gh` authed as AysajanE. Docker + node 22.
- OSS commit identity is `aeziz@northset.ai`, set per-clone, never global.
