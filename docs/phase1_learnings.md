# Phase 1 learning log

This is an evidence log for improving later Northset OSS phases. It is not runtime policy, a new
gate, or a roadmap. Workflow changes still belong in the operating contract and code.

## 2026-07-20 — first publication and maintainer-response batch

### Evidence snapshot

The local factory database recorded 391 candidate tasks: 13 receipt-attested submissions, 5
approved items awaiting completion, 1 READY item, 16 owner rejections, 106 failed attempts, and 250
skips. Its publication table recorded 13 submitted pull requests—10 open, 1 merged, and 2 closed—and
one additional receipt-published item whose PR creation stopped at the hourly cap.

Live GitHub state also showed two importantly different human outcomes:

- `Open-Resin-Alliance/DragonFruit#417` received a contributor approval and a warm thank-you, but it
  was still open. Its failing macOS job was a repository signing-configuration failure, not evidence
  that the patch failed.
- `ninoseki/vscode-mogami#197` was merged, but had no maintainer thank-you or review comment.

### Bottleneck register

This register distinguishes the current limiting factor from secondary throughput losses. The
measurements cover attempts from 2026-07-19 12:13 UTC through 2026-07-20 11:38 UTC and should be
recalculated before using them to design the next phase.

1. **Observed hard limiter — the internal publication governor.** The then-configured ceiling was four
   new PRs per hour. Four PRs had been recorded in the current hour, M-1028 stopped at that ceiling after
   its receipt was published, and five more items were approved but not yet submitted. GitHub was not
   paused and the read-only status showed no primary-rate wait. Therefore the immediate constraint on
   visible delivery was Northset's conservative publication cap, not candidate supply, verification
   capacity, receipt attestation, or GitHub's primary API quota.
2. **Largest internal worker-time bottleneck — clean-verification attrition.** Of 366 attempts, 39
   verified (10.7%). The 34 verification-stage skips consumed 5.54 of 13.6 aggregate worker-hours
   (40.7%), while successful verification consumed 2.49 hours. This is the largest measured compute
   sink and the strongest next-phase target for analyzing issue fit, authoring accuracy, declared
   checks, and the usefulness of the single correction attempt.
3. **Candidate-to-lane mismatch — cheap capacity loss.** The lake held 1,687 open Node issues, so
   candidate supply was ample. Yet 63 factory tasks ended because they were multi-package workspaces
   outside the lane and 37 ended with no root `package.json`: 100 of 391 tasks (25.6%). Another 32
   ended in clone timeout/failure (8.2%). A small deterministic preflight may recover worker capacity
   if it can reject these shapes more cheaply than a worker, but this does not justify a larger
   qualification system.
4. **Board serialization plus operator absence — bursty queue delay.** One board waited 660 minutes
   for approval; while it remained open, five later READY items waited 632–685 minutes before their
   board was created. This was not the normal review pace—other observed board approvals completed in
   0–116 minutes, and the next five-item board was approved in seconds—but a single-open-board design
   can amplify a long operator absence. Measure recurrence before changing the design.
5. **Model-client failures — misclassified retryable loss.** Six tasks ended on invalid Codex identity
   JWTs and eight on a rejected output schema. These failures were quick and therefore not the main
   time sink, but they inflated candidate failures without saying anything about issue quality. Later
   reporting and retry policy should classify provider/auth/schema incidents separately from worker
   or patch failures.
6. **Maintainer response latency — external end-to-end constraint, not yet a verdict.** The cohort had
   13 submitted PRs but was less than a day old: 10 remained open, 1 had merged, and 2 had closed. The
   merge fraction is therefore too immature to judge candidate quality. Track time to first human
   response and disposition by repository before treating maintainer latency as a phase-design
   problem.
7. **Not currently limiting.** Receipt attestation had completed for all 13 submitted PRs.
   Infrastructure-class attempts accounted for 15 of 366 attempts (4.1%) and 0.29 of 13.6
   worker-hours (2.1%). Docker and infrastructure faults still require correct retry classification,
   but after cleanup they were not the dominant Phase 1 bottleneck in this window.

### Controlled throughput experiment and minimum hardening

On 2026-07-20 the hourly publication ceiling moved from four to six. This is a measured Phase 1
experiment, not a quality trade. The one-open-PR-per-repository cap, two-per-owner daily cap,
30-per-day cap, serialized mutation pacing, exact-byte approval, clean verification, final live
rechecks, and immediate stop behavior for platform or maintainer signals remain unchanged.

The same change set hardened demonstrated secondary losses:

- An internal publication-cap hit now preserves approval and the latest branch checkpoint instead of
  marking a verified item failed. A retry after capacity returns can adopt the exact branch and
  continue. The old `GITHUB_PUBLIC_LIMIT` failure shape is repaired on retry without a new state.
- Live preflight now recognizes root pnpm workspace files and `lerna.json`; the checkout scout also
  turns a missing root `package.json` into a candidate skip before any model or bootstrap call.
- A transient scout/provider failure gets one bounded retry. Codex JWT and output-schema failures are
  classified as infrastructure rather than patch quality, and an exhausted infrastructure retry no
  longer consumes the corrective author loop.

The first live six-per-hour window behaved correctly: as two slots aged out, M-1032 and M-1033 were
submitted; M-1034 and M-1035 remained approved at their pushed-branch checkpoints when the new
ceiling was reached. No verification or final-recheck rule changed, and the deferred items were not
misreported as patch failures.

Publication recovery also exposed an asynchronous-state hazard. A successful rerun must not
downgrade an already attested receipt, published status, or task state, and a transient read error
must not erase the factual `SUBMITTED` state. Bot-authored edits to a PR body are another
external-state change:
when repository, base, branch, head OID, PR number, and URL still match, preserve the submission and
record text drift rather than overwriting the maintainer/bot text. Any local patch change still
invalidates the old content-bound approval and requires a new review board.

Evaluate the six-per-hour experiment using actual signals: secondary-limit or abuse responses,
maintainer stop/burden messages, first-human-response latency, close reasons, merge outcomes, and the
size of the approved queue. The first such signal still stops or lowers publication; absence of a
signal is evidence to continue measuring, not permission to weaken verification.

The next live reconciliation added two quality lessons. `thunderbird-conversations#2396` shows that a
maintainer-required manual UI check is part of acceptance even when automated tests pass; publication
speed cannot substitute for that evidence. `goptics/vizb#243` shows that behavior tests alone may miss
palette-dependent readability, so repository-native visual contrast conventions must be checked for
UI changes. The unboarded M-1036 also demonstrates that a large multi-file item with only one focused
test and blocked lint must surface that risk rather than entering review with empty warnings.

### Carry-forward lessons

1. **Use exact outcome words.** A thank-you, approval, merge, green CI result, receipt publication,
   and attestation are different events. Check live `state`, `mergedAt`, reviews, comments, and checks
   immediately before describing an outcome or posting a follow-up.
2. **Report the delivery funnel, not one ambiguous total.** Keep READY, approved, receipt-published,
   PR-opened, attested, closed, and merged counts separate. Count a successfully opened PR only when
   a verified upstream PR URL exists. The ledger is proof and reconciliation output; it is not a
   substitute for live upstream state.
3. **Classify failures by ownership before rejecting work.** Retry or re-examine transient local
   Docker, storage, and capacity failures. Record upstream repository CI/configuration failures as
   external unless the patch caused them. Do not modify a correct patch merely to chase unrelated
   infrastructure failures.
4. **Treat partial publication honestly.** The hourly-cap stop after the receipt for M-1028 was
   published demonstrates that receipt publication does not mean upstream delivery. Partial batches
   must remain visible and must not inflate the submitted-PR count.
5. **Build relationships from real human signals.** A useful follow-up target combines active
   maintenance, a substantive human response, and another bounded issue that fits Northset's lane.
   Do not ping a merged PR merely to manufacture engagement when the maintainer has not responded.
6. **Make the next-step request specific and low-pressure.** When the current PR is still open,
   thank maintainers for the review rather than claiming a merge. Offer one checked, unassigned issue
   for assignment after the current change lands; avoid a generic request for more work.
7. **Relationship work does not override publication safety.** An assignment can establish a future
   rung in the contribution ladder, but authoring and publication still respect the one-open-PR rule,
   repository cooldowns, and GitHub limits.
8. **Optimize for repeatable trust, not raw PR count.** Responsive maintainers and well-scoped work
   are stronger next-phase signals than repository popularity alone. Prefer a smaller set of healthy
   repeat relationships while continuing broad local preparation.

These lessons should influence candidate ranking, operator reporting, and maintainer follow-up. They
should remain lightweight heuristics or asynchronous reconciliation behavior unless a demonstrated
integrity or account-safety failure requires a blocking control.
