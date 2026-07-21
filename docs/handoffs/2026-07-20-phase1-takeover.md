# Northset OSS Phase 1 takeover — 2026-07-20 15:30 EDT

## Authority and immediate stop boundary

This handoff follows completion of the requested local round. The two new contributions are committed, clean-verified, READY, and frozen on one OPEN review board. They are **not approved, pushed, published, or opened as pull requests**.

The next team must independently inspect the current board and live state. It must not record approval, push a branch, publish a receipt, open or edit a pull request, or post a comment until the user explicitly authorizes that exact content-bound action. After this handoff, the originating session is paused.

The active repository instructions are the lean one-way flow:

```text
discover/preflight -> author -> clean verify -> READY
-> one human batch approval -> paced push/PR
-> asynchronous receipt, attestation, and outcome reconciliation
```

Do not revive `campaign/phase0`, `campaign/phase1`, archived control-plane machinery, shifts, JIT windows, extra approval stages, or synchronous receipt/attestation gates.

## New immutable review board

- Board ID: `B-9364D47D254DEA18`
- Board digest: `sha256:9364d47d254dea18426aff50be431250034d6c5d9d7d51c9bcc817a283bc9797`
- State: `OPEN`
- Created: `2026-07-20T19:28:06.887Z`
- Items: exactly `M-1051` and `M-1052`
- Rendered board: `runs/factory/B-9364D47D254DEA18.md`
- Rendered-board file digest: `sha256:62cc7c1c1c1c2a67b86a517a37e26ef4bda0ec1f9650593fc0fefe21a395a9ca`
- Verification: a fresh `node factory/cli.mjs board` render matched the saved board byte-for-byte.

No approval exists for this board. A suitable future user authorization would need to name the selected mission IDs and this exact board digest. Do not infer approval from the request that created the board.

### M-1051 — ProjectMirador/mirador#3904

- Issue: `https://github.com/ProjectMirador/mirador/issues/3904`
- Purpose: remove the window section's redundant accessible name while retaining the manifest title as a navigable `h2`.
- Board-facing risk: `AMBER`; the board classifier treats modified existing tests as AMBER, and this intentional accessible-query migration also touches more than five files. Production change is three deleted lines; the remaining changes are tests/helpers.
- Local source branch: `northset/mirador-3904-redundant-title`
- Immutable public target: `AysajanE/mirador:northset/m-1051`
- Reviewed base: `25b79f3435b43f303555e1c14dc03ea6564713e6`
- Commit: `ccc87ef410a5fac063613f67858bb80cd00a87ab`
- Tree: `12a03436535c8c713efb8f7ba10d1f761023fdb5`
- Patch: `sha256:760387bd7ad88cc2238a4e74014bd464e3391ae18364a139617c07034bb0dc84`
- Manifest: `sha256:ec99c9d7707cbd6a20955329f7070c5e15e097c5e98d254e134e5bad9c57720b`
- Item digest: `sha256:5e434d8bf0ea5e84626453cf26401509ec5ec741be5f833d6d74ee2b348cad66`
- Identity/signoff: author and committer are `Aysajan Eziz <aeziz@northset.ai>`; DCO signoff is present.
- Clean verifier: immutable image `sha256:53ac35edd320b9e6442195b6334e8ae2a9396167a7a92cbf6dd53cb475342f5d`, `arm64`, no network, no credentials, no Docker socket, read-only dependencies.
- Exact base observation: the four-file focused suite failed one intended regression and passed 22 tests; output digest `sha256:e96799d2cf073246cbc89508570d7dc2700d87e7531bf5f9f48abcb4a868df6d`.
- Exact patched observation: the same suite passed 23/23; output digest `sha256:1335118f1550e66f491977c089348090e1559c36a55cfc3249d6a05154757214`.
- Additional completed checks: affected integration tests 3/3; full coverage suite 1182 passed and 12 skipped across 188 passing files and 2 skipped files; production builds, full lint, formatting, and size checks passed.
- Limitation disclosed on the board: no assistive-technology session was run; the regression asserts the accessible DOM contract and retained heading.
- Live snapshot at board preparation: issue OPEN/unlocked, no assignee, no linked PR, `good first issue`, collaborator explicitly proposed removing the label.
- Live default head then: `ce4297ba9684b04feaa4c606c4c9e45d4e672c20`. The reviewed base is its ancestor and the patch merged cleanly in a local merge-tree check. Recheck immediately before submission.

### M-1052 — Sirivasv/bmssp-js#165

- Issue: `https://github.com/Sirivasv/bmssp-js/issues/165`
- Purpose: validate constructor input shape, finite numeric node IDs, and finite nonnegative weights with indexed errors; preserve empty-graph construction.
- Board-facing risk: `AMBER` because the board classifier treats the modified existing test file as AMBER. The READY row's stored lane tier is GREEN, but approval and publication must use the board-facing AMBER classification.
- Local source branch: `northset/bmssp-165-input-validation`
- Immutable public target: `AysajanE/bmssp-js:northset/m-1052`
- Reviewed base: `688b5d94f00f557ac69955f9fd852514de0560bb`
- Commit: `c1b940eb385c52ee8c0f56886d5edf58a185c5bf`
- Tree: `ccc2f2e803c7dde475bc1103a3ae2d7d6b0defb7`
- Patch: `sha256:a1982d75c87915c375c7417e4a4631247fbc38fe335eb0e54c668a853417572f`
- Manifest: `sha256:c0d52b59618599f0d915a5608c499a9d6e2429cda7e850357df187e37f9fc41a`
- Item digest: `sha256:c8cc2ab8d7c409c8c50a5c6e5d1d598344e48c99f8b084183325ea3133e4bdc1`
- Identity/signoff: author and committer are `Aysajan Eziz <aeziz@northset.ai>`; DCO signoff is present.
- Clean verifier: same immutable image and isolation as M-1051.
- Exact declared command: `npm test -- --runInBand --no-cache --coverageDirectory=/tmp/bmssp165-full && npm run lint`.
- Exact base observation: failed only the four new validation cases; output digest `sha256:312ca78117f98c6fa93ce41b3669951dd5f1a73face554d949dc94661751826b`.
- Exact patched observation: 135 passed, 1 skipped, then lint passed; output digest `sha256:3c7a2e54dddf266d61ee035c47dde43a12053577efe292f784805eaa6dc9d9dc`.
- Live snapshot at board preparation: issue OPEN/unlocked, assigned to `AysajanE`, owner invited the contribution, and no competing open PR was linked. The user already posted the short work-in-progress reply; do not duplicate it.
- Live default head then: `033733f2b2f37b2fc7ab02adab895bc693978253`. The reviewed base is its ancestor and the patch merged cleanly in a local merge-tree check. Recheck immediately before submission.

## Factory and safety snapshot

At handoff:

- Tasks: `567`
- Attempts: `449`
- READY records: `53`
- Boards: `28`
- Submitted publications: `30`
- QUEUED/WORKING tasks: `0`
- PENDING READY records: `2` — M-1051 and M-1052
- OPEN boards: `1` — the board above
- GitHub queue depth: `0`
- GitHub safety pause: clear
- Limits: one open PR per repository, two per owner per day, six per hour, thirty per day
- Prior secondary-limit pause was cleared at `2026-07-20T18:04:49.227Z` after the user-authorized cooldown probe.
- GitHub CLI authentication is active as `AysajanE`.
- Codex reports `Logged in using ChatGPT`.

`M-1046` remains approved but unsubmitted for `mtgred/netrunner`. Do not publish it while M-1048 / PR `https://github.com/mtgred/netrunner/pull/8801` is open; the one-open-PR-per-repository rule applies.

The local publication table currently has 30 submitted records and 30 receipt attestations. Its last reconciliation snapshot reports:

- CI failures requiring triage: M-1009 / ClearskyUI #443, M-1011 / DragonFruit #417, and M-1050 / devtasks #414.
- CI success: nine records, including merged M-1020, M-1021, and M-1034.
- CI pending: 18 records.

These are local last-observed facts, not a guarantee of current GitHub state. Refresh/reconcile before acting on maintainer messages, CI, merges, closures, or one-open-PR gates. Prioritize maintainer replies and corrections over new submissions.

## Local work that must be preserved

The orchestrator `main` worktree intentionally contains 21 tracked modified files: 780 insertions and 237 deletions. It also contains the untracked local takeover report `docs/handoffs/2026-07-20-phase1-takeover.md`. They are not committed in this handoff. Do not discard or sweep them into an unrelated commit.

The changes include:

- high-level Phase 1 learning synthesis;
- exact durable-patch representation checks;
- a single-process factory run lock;
- safe deferral/requeue for provider unavailability and GitHub pauses;
- infrastructure-only retry recovery;
- host Codex token-invalidated/revoked classification;
- preflight rejection of repository `unapproved` labels and expanded occupancy phrasing;
- final live invitation-label verification;
- correction/approval supersession protection;
- receipt Git HTTP-status classification;
- reconciliation cleanup of stale errors;
- focused acceptance coverage for those behaviors.

The last recorded focused/root verification for these changes was 188/188 passing. Re-run the relevant focused tests after any overlapping edit; run the full root suite before committing shared publication/safety behavior.

The `northset-oss` worktree is ahead of its remote by one user-owned commit and has two uncommitted files:

- `lib/factory-receipts.mjs`
- `test/factory-receipts.test.mjs`

Those changes validate exact PR URL binding and maximum publication observation time; the focused suite previously passed 9/9. Preserve them and do not commit/push them without current user authorization.

The import backup is `runs/factory/backups/pre-bmssp-mirador-ready-20260720T1929.sqlite`; its integrity check passed and its next mission value is 1051. The manual import script and generated source patches are ignored run artifacts. The immutable READY artifacts referenced by the board are the approval truth.

## Exact takeover sequence

1. Read the repository operating instructions and this report, then independently review `node factory/cli.mjs board`.
2. Confirm the OPEN board digest and both item/manifest/patch/commit/tree bindings still match the values above.
3. Refresh live GitHub state for both issues: open/unlocked, invitation/assignment, occupancy/overlap, repository cap/cooldown, default head, and patch applicability.
4. Present M-1051 and M-1052 together for one digest-bound human decision. Do not assume approval.
5. If and only if the user explicitly approves selected IDs on the exact digest, record that exact decision with the active CLI. A rejection or partial approval must name the rejected IDs.
6. If and only if the user also explicitly authorizes publication, publish the approved board through the serialized safety governor. Stop immediately on 403, 429, `Retry-After`, secondary-limit/abuse signals, warnings, or a maintainer stop.
7. Verify pushed OID and PR-head OID match the approved commit, then read back exact title/body/base/head.
8. Reconcile receipt, attestation, and outcome asynchronously. Do not make receipt availability a precondition for opening an already approved PR.
9. After completing the authorized batch, stop. Do not resume candidate work unless the user asks.

## Prohibited shortcuts

- Do not rebase or amend either reviewed commit after approval; that changes the bound bytes and requires a replacement READY item and new board.
- Do not edit PR text, targets, branch names, claims, or planned public actions after approval.
- Do not reuse the earlier noncanonical bmssp digest `b956…`; the factory-canonical digest is `sha256:a1982d75…`.
- Do not post another bmssp work-in-progress comment.
- Do not treat contributor self-run evidence as maintainer verification, security review, or a correctness guarantee.
- Do not bypass GitHub limits using another account or identity.
