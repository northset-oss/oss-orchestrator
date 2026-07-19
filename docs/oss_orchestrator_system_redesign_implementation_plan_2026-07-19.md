# OSS orchestrator redesign implementation plan

This plan implements `oss_orchestrator_system_redesign_2026-07-19.md` as a new,
small active factory path. It does not incrementally add exceptions to the legacy
campaign runtime.

## 1. Binding operating contract

The implementation is complete only when all of the following are true:

1. Local discovery, preflight, checkout, authoring, verification, READY creation,
   board generation, and receipt preparation run without a shift, NTP, Phase-1,
   calibration, or human gate.
2. Failed local attempts have task and attempt identities but no public mission ID.
3. A mission ID is allocated transactionally only when a verified result becomes
   READY.
4. One immutable board binds exact target, patch, tree, commit, checks, PR title/body,
   receipt claim, risk, and planned public actions.
5. One owner approval can select a subset; changing one selected item invalidates
   only that item.
6. The publisher performs a final live collision check, pushes the exact approved
   commit, opens or adopts one exact PR, reads it back, and then reports SUBMITTED.
7. Receipt attestation and final status reconciliation are asynchronous and cannot
   duplicate, close, or demote an already opened PR.
8. One small GitHub safety queue controls GitHub reads, mutations, and pushes. A
   secondary limit stops the queue and writes one pause record; it never stops local
   workers.
9. Repository cooldown, one-open-PR, owner/day, hourly, and daily public limits are
   enforced only in the publisher.
10. The active path imports none of the legacy schedule, calibration, campaign
    controls, gateway, or ship state machine.

## 2. Active modules and ownership

### `factory/db.mjs`

Own one SQLite database and all state transitions.

- Tables: `factory_meta`, `tasks`, `attempts`, `ready_items`, `boards`,
  `board_items`, `board_approvals`, `publications`, and `repository_state`.
- Task states: `DISCOVERED`, `QUEUED`, `WORKING`, `VERIFIED`, `READY`, `APPROVED`,
  `PR_OPENED`, `RECEIPT_ATTESTED`, `SKIPPED`, `FAILED`, `REJECTED_BY_OWNER`, and
  `SUPERSEDED`.
- Generate `task_id` from the canonical issue identity.
- Generate UUID attempt IDs.
- Allocate monotonically increasing `M-*` IDs only in the VERIFIED-to-READY
  transaction.
- Keep board snapshots immutable.
- Store remote branch and PR checkpoints independently so a crash between a remote
  action and its local checkpoint can be recovered by exact remote adoption.

### `factory/source.mjs`

Use the existing candidate lake as a supply source, not as the new runtime database.

- Select Node candidates from discovery records up to 14 days old.
- Do not require a semantic review record or its two-hour expiry.
- Rank initially by mechanical score adjusted by observed factory conversion and
  duration; no ML service.
- Select at most `2 * workers` by default and never more than `4 * workers` for live
  preflight.
- Perform one consolidated live query for issue state, assignment, invitation,
  repository status, Northset open PRs, exact linked PRs, claimant signals, and base
  OID.
- Return `GO`, `SKIP`, or `ESCALATE`; deep overlap work exists only for `ESCALATE`.
- Enqueue stable tasks without mission IDs.

### `factory/worker.mjs`

Run a continuous private factory using separate stage semaphores.

- Default lane: Node only.
- Stages: preflight, clone, dependency bootstrap, scout, author, verifier, READY.
- Scout output is exactly `decision`, `reason`, `test_command`, `target_files`, and
  `estimated_risk`.
- Use direct-fix authoring by default.
- On the first author/verifier failure, give the exact failure to one second attempt.
- After the second failure, mark the task SKIPPED in the standard lane.
- One infrastructure retry remains within the same attempt.
- Local work does not read GitHub publication pause state.
- Promote verified work through the database and invoke event-driven board creation.

### `factory/verifier.mjs`

Provide one base observation and one clean patched observation.

- Typed claims: `regression_fix`, `existing_check_repair`, `coverage_addition`, and
  `test_infrastructure_fix`.
- Verify tracked-tree stability after the final check.
- Verify patch -> tested tree -> commit binding.
- Build the dependency key from repository node ID, profile, image, architecture,
  install digest, dependency manifests/lockfiles, and trust domain.
- Exclude candidate, mission, and base commit from the key.
- Represent dependency material as a content-keyed volume writable only during
  bootstrap and read-only during author/verifier use.
- Build compact immutable `proof.json` bytes containing exact observations,
  structured executed-command timing and results, checks not run, limitations,
  environment and image identity, output hashes, claim, and approval binding.
- Publish a digest-bound `current.json` pointer for the ledger projection, use the canonical
  Pages receipt URL in approved PR bytes, and reconcile the public HTML and JSON projection
  asynchronously without delaying an approved upstream branch or PR.

### `factory/board.mjs`

Create small event-driven owner boards.

- Trigger at ten READY items, oldest READY age of 30 minutes, explicit owner request,
  or configured maximum.
- Show repository/issue, invitation/collision result, summary, files/diffstat, risk,
  base and patched observations, checks, exact PR title/body, receipt claim, and links.
- Green is batch-approvable; Amber is selected individually; Red is skipped by the
  scaled lane.
- Approval records bind the board digest, approved IDs, rejected IDs, actor, and time.
- No per-mission signature or reviewer-calibration state exists.

### `factory/github-safety.mjs`

Replace the production use of the legacy gateway with one serial priority queue and
one pause file.

- Priorities: maintainer response, final submission, reconciliation, live preflight,
  discovery top-up.
- Reads are serialized without a fixed six-second delay.
- Search starts are spaced at least two seconds apart.
- Mutations are spaced at least 1.25 seconds apart by default.
- PR creation is separately governed by repository and public-action limits.
- Ordinary response headers provide rate information.
- Primary exhaustion waits until reset and resumes automatically.
- Transient network/5xx gets one retry.
- Secondary/abuse/429/Retry-After stops the current and queued requests without retry,
  writes one pause record, honors the interval, requires one owner resume, and runs
  one probe.
- Platform warning/account restriction cannot be locally resumed.

### `factory/publisher.mjs`

Publish exact approved items and checkpoint every external step.

1. Revalidate the current item digest against its approval.
2. Run the final live collision/cooldown/cap check immediately before the item.
3. Prepublish the immutable receipt proof in one append-only batch operation.
4. Push or adopt the deterministic fork branch at the exact approved OID; never force.
5. Adopt an exact existing PR or create one only when absent.
6. Read back title, body, base, head, repository, and number.
7. Mark `PR_OPENED`/`SUBMITTED` with `ATTESTATION_PENDING`.
8. Reconcile attestation and final outcome asynchronously.

A stale or mismatched item fails independently; clean peers continue.

### `factory/cli.mjs`

Implement the documented commands:

- `run`
- `board`
- `approve`
- `publish`
- `github-status`
- `github-resume`

There is no shift activation, JIT window, NTP gate, handoff, profile exit gate,
calibration command, scheduled board, or per-mission signature command.

## 3. Transitional legacy changes

These changes prevent the old path from contradicting the adopted policy while the
new path is being proven:

1. Correct the PR footer to: “AI assistance was used. This change was reviewed by
   Northset, and I accept responsibility for this submission.”
2. Make direct-fix the default in spec finalization.
3. Remove candidate, mission/task, and base commit from the dependency cache key and
   include all dependency manifests.
4. Stop passing Phase-1 runtime guards from ordinary qualify/prepare/ship CLI paths.
5. Stop claim comments by default.
6. Keep Phase-1 metrics report-only.

The new active modules must not import the legacy gateway, `ship.mjs`,
`runtime-guard.mjs`, campaign controls, review rosters, or calibration policy.

## 4. Deterministic acceptance proof

Four offline suites prove the redesign:

### Local factory

- 50 lake candidates enqueue without schedule fields.
- Multiple workers start immediately.
- Failed work consumes no mission IDs.
- Ten verified results automatically create a board.
- Subset approval works.
- Changing one item invalidates only that approval.

### Verifier

- Regression base-red/patched-green.
- Existing-check repair.
- Coverage-only claim without a defect assertion.
- Dependency volume read-only after bootstrap.
- Tracked-source mutation fails.
- Patch/tree/commit mismatch fails.

### Publisher

- Resume after seven of twenty pushes without duplicates.
- Adopt seven exact PRs after a crash without duplicates.
- Remove one stale item without stopping peers.
- Reject stored PR body/head mismatch for that item only.
- Attestation failure leaves one open PR and pending proof.
- Final status failure leaves a recoverable submitted state.

### GitHub safety

- Secondary limit stops the whole GitHub queue immediately.
- Retry-After blocks early resume and permits exactly one later probe.
- Primary exhaustion waits for reset.
- Mutation spacing is enforced.
- Cooldown and one-open-PR cap reject before transport.
- Local workers continue while publication is paused.

Focused command:

```sh
node --test \
  factory/factory.acceptance.test.mjs \
  factory/verifier.acceptance.test.mjs \
  factory/publisher.acceptance.test.mjs \
  factory/github-safety.acceptance.test.mjs
```

Then run the full repository suite and `git diff --check`.

## 5. Cutover and legacy retirement

Cut over only after the acceptance suite proves prepare/READY, subset approval,
crash-safe submission, and throttle isolation.

1. Make `factory/cli.mjs` the documented production entry point.
2. Mark `oss.mjs`, `ship.mjs`, `find-candidates.mjs qualify`, and campaign Phase-1
   commands as legacy compatibility tools.
3. Remove all production imports from `factory/` to campaign runtime and the old
   gateway.
4. Move research, calibration, Phase-0 rehearsal, backups, attribution, and outcome
   reporting off the active path. They may continue reading factory records.
5. Keep legacy source long enough for historical receipts and recovery, but do not
   execute or document it as the production factory.

The cutover does not start public publishing, resume Phase 1, or open any PR. Those
remain explicit owner actions through the new batch approval and publisher commands.
