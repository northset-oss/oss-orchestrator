# Phase 1 learnings

This document records cross-cutting lessons from Phase 1 that should improve later Northset OSS
phases. It is a synthesis, not an issue journal, runtime policy, or catalogue of individual missions.

## What Phase 1 established

- The lean flow works: discover and preflight, author, cleanly verify, mark READY, obtain one
  content-bound approval, publish at a controlled pace, then reconcile receipts and outcomes
  asynchronously.
- The path after READY is reliable. Publication receipts and attestations have not been the main
  constraint. The harder problems are finding genuinely suitable work and converting an eligible
  issue into a patch that proves the maintainer's actual contract.
- Quality is the basis of throughput, not its opposite. A smaller number of precise, well-tested
  contributions creates more durable value than a larger number of superficially green patches.
- Maintainer trust is a compounding asset. Clear scope, accurate claims, fast corrections, and
  respect for repository conventions make repeat collaboration more likely.

At the latest Phase 1 snapshot, the lake contained roughly 3,800 issues, while the factory had
created 566 tasks, produced 51 distinct READY results, and submitted 30 pull requests. These figures
are a point-in-time baseline, not a permanent conversion rate. They show that the primary opportunity
is improving qualified supply and author-to-verifier conversion, not adding publication machinery.

## Limiting factors and bottlenecks

### 1. Trustworthy candidate supply

The lake is large, but its nominal size overstates usable supply. Language labels, invitation labels,
issue state, repository activity, package topology, existing claims, overlapping work, and current
maintainer intent all drift. Cached metadata is useful for narrowing the search, but it is not proof
that an issue is currently suitable.

The practical response is a cheap cached filter followed by live hydration of only a small shortlist.
Do not compensate for weak supply by lowering issue-fit standards, expanding into unsupported lanes,
or crawling broadly when existing stock has not been exhausted carefully.

### 2. Author-to-clean-verifier conversion

The largest internal loss occurs when a plausible patch reaches verification but does not prove the
requested behavior. Common causes are misunderstanding the maintainer's contract, testing mocks or
implementation details instead of the disputed boundary, omitting the build or compiler for the
changed language, and relying on stale or environment-dependent observations.

The highest-leverage improvement is better contract extraction before editing, followed by one
focused implementation and one bounded correction attempt. More reviewers, longer state machines,
or open-ended repair loops would add cost without addressing this bottleneck.

### 3. External and infrastructure constraints

Provider availability, Docker storage, network transport, GitHub secondary limits, and upstream CI
configuration can temporarily stop or distort work. These events must be classified separately from
candidate quality and patch quality. A recoverable environment failure should preserve the candidate
and its remaining attempt; a deterministic code failure should not be relabeled as infrastructure.

### 4. Publication capacity

Serialized publication and conservative hourly or daily limits can create short queues, especially
after an operator absence. Raising a pacing limit is acceptable only as a measured experiment while
exact-byte approval, final live rechecks, one-open-PR rules, and stop-on-platform-signal behavior remain
unchanged. Primary API quota is not evidence that GitHub's secondary-abuse tolerance is available.

## Candidate-selection lessons

- Read the current issue discussion, nearest contribution instructions, default/base-branch policy,
  pull-request template, and repository-specific testing expectations before authoring.
- Recheck invitation, vacancy, assignment, claims, overlapping work, issue openness, and base movement
  immediately before public submission. Discovery-time consent is not enough.
- Require a current, testable behavioral contract. Platform-specific latency or intermittent failures
  need a present reproduction and useful trace before a causal fix can be justified.
- Validate named external APIs and required response fields before implementing an integration. A
  missing upstream contract is not permission to invent a new ingestion or caching subsystem.
- Keep pilot profiles isolated from the proven production lane. A large lake should not create pressure
  to treat language or repository-shape false positives as eligible work.

## Authoring and verification lessons

- Tests must exercise the maintainer's contract, especially the boundary under discussion. A green
  test that merely confirms the author's implementation is weak evidence.
- Run the repository-native compiler or production build for the language changed. Source-pattern
  tests, type checks, and unit tests cannot establish that generated or compiled output is valid.
- UI work needs proportionate visual or browser evidence when automated tests cannot establish layout,
  interaction, contrast, or timing. State clearly when evidence is component-level rather than a full
  end-to-end environment.
- Base and patched observations must use isolated or disabled test caches. Shared runner caches can
  make a base tree appear to contain a regression test that exists only in the patch.
- Keep dependency inputs immutable. Redirect or disable build-tool caches instead of making a clean
  verifier's dependency mount writable.
- Bind the exact base, patch bytes, tested tree, commit, pushed object, and pull-request head. Exact
  identity checks are worth retaining because they protect the central proof claim.
- Public claims must match the checks actually run. Contributor self-run evidence is useful but is not
  maintainer verification, a security review, or a guarantee of overall code quality.

## Failure-classification lessons

- Separate candidate-contract failures, authoring defects, verifier defects, provider failures, local
  infrastructure failures, upstream CI failures, and GitHub safety stops. They require different
  recovery actions and should not consume the same retry budget.
- Diagnose Docker capacity from Docker's own images, volumes, and build cache; host free space alone can
  be misleading. Reclaim only unused caches, then rerun the candidate before rejecting it.
- Treat external preview authorization, withheld fork secrets, and maintainer infrastructure failures
  as external unless evidence connects them to the patch. Do not change correct code to chase them.
- Probe a changed model-provider account with one harmless non-candidate request before spending a real
  candidate attempt.
- Preserve settled public truth across retries and reconciliation. Transient read errors or historical
  local state must not downgrade a submitted, attested, or corrected contribution.

## Publication and account-safety lessons

- Serialize GitHub mutations and stop on secondary-limit, abuse, warning, or maintainer-stop signals.
  Local filtering, authoring, and verification should continue while public traffic is paused.
- Keep receipts, attestations, status pages, and outcome reconciliation asynchronous. They improve
  traceability but should not delay an approved upstream pull request.
- Treat partial publication honestly: an approved item, pushed branch, opened pull request, published
  receipt, attestation, merge, and maintainer approval are distinct states.
- A concurrent runner can corrupt attribution or duplicate work. One narrow crash-safe run lock is
  justified; additional schedulers or workflow states are not.

## Maintainer-relationship lessons

- Build relationships from substantive human signals, not automated messages or raw repository
  popularity.
- Follow up with specific, factual thanks. Ask about another bounded contribution only when the
  repository is active, the interaction was positive, and the work advances Northset's later mission.
- Keep requests low-pressure and respect the repository's open-work and cooldown boundaries.
- Optimize for repeatable trust: accurate work in a smaller set of healthy maintainer relationships is
  more valuable than maximizing one-off pull-request count.

## Principles to carry into later phases

1. Improve candidate truth and authoring accuracy before increasing parallelism.
2. Keep demonstrated integrity and account-safety failures as hard gates; make other observations
   telemetry, warnings, or asynchronous work.
3. Prefer the smallest deterministic fix and one meaningful correction loop.
4. Measure conversion, failure ownership, maintainer response, and durable outcomes separately.
5. Remove recurring secondary losses when the remedy is small and proven, but do not build generalized
   systems for hypothetical cases.
6. Revisit these lessons using aggregate evidence from the next phase, not anecdotes from individual
   issues.
