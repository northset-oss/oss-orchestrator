# Northset OSS Orchestrator — Agent Instructions

Scope: this file governs the entire `oss-orchestrator` repository.

## Mission

Build the smallest reliable factory that turns suitable OSS issues into verified READY patches, then submits only human-approved batches without endangering the GitHub account.

Optimize for:

1. verified READY patches per lane-hour;
2. correctness of the patch and receipt;
3. low maintainer and GitHub-account risk;
4. less code, fewer states, and fewer synchronous gates.

Do not optimize for theoretical completeness, future scale, maximum audit detail, or the number of controls implemented.

## Default behavior

- Inspect, patch, run focused tests, and stop when the requested behavior works.
- Prefer deletion or reuse over adding a subsystem.
- Make the smallest coherent change that solves the current task.
- Treat local, private, reversible work as autonomous.
- Require human approval only for irreversible public actions: pushing branches, opening or modifying upstream PRs, posting comments, merging, or publishing releases.
- Never create a design program, policy framework, migration system, dashboard, or generalized abstraction unless the user explicitly requests it or the current task cannot be solved without it.
- Do not fix unrelated defects, refactor adjacent code, or “harden” hypothetical future cases.

## Required safety kernel

Only these concerns justify a blocking production gate:

1. Untrusted repository code receives no host secrets, GitHub credentials, signing credentials, Docker socket, or unsafe host mounts.
2. A clean verifier runs the exact declared checks on the exact approved patch.
3. Patch digest, tested tree, commit, pushed OID, and PR-head OID remain bound.
4. Immediately before submission, recheck that the issue is open, the work is not occupied or duplicated, repository cooldowns/caps allow submission, and the approved patch still applies.
5. One content-bound human batch approval covers the exact selected diffs, PR text, claims, targets, and public actions.
6. Stop GitHub-facing actions on `403`, `429`, `Retry-After`, secondary-limit/abuse signals, platform warnings, or an explicit maintainer stop request. Do not hammer retries.
7. Claims remain narrow and factual: contributor self-run evidence is not maintainer verification, security review, or a code-quality guarantee.

Everything else should be telemetry, a warning, an asynchronous task, or a later optimization—not a synchronous gate.

## Do not reintroduce legacy control-plane complexity

Unless the user explicitly asks for it, do not add or restore:

- shifts, board times, JIT windows, NTP gates, calendar gates, or human-capacity schedulers;
- dual-review calibration, reviewer-key ceremonies, per-mission signatures, or handoff protocols;
- outcome, social, cost-attribution, corpus, or profile-graduation metrics that block local work;
- multiple approval stages for one batch;
- pre-author claim comments by default;
- a mandatory deep semantic-model review for every candidate;
- a new public mission ID for each local retry;
- waits for internal ledger PRs, attestation, Pages, or receipt HTTP availability before an approved upstream PR can open;
- separate persistent state files representing the same pause or incident;
- daily request-budget algorithms, wave-budget ceremonies, or policy engines where a small serialized GitHub queue and one pause record suffice;
- compatibility layers for unused campaign behavior.

`campaign/phase0/`, `campaign/phase1/`, and `archive/` are legacy, research, reporting, or historical material. Do not import them into the active execution path unless the task explicitly targets them. Prefer removing active dependencies on them.

## Desired active flow

Move the repository toward this one-way flow:

```text
discover/preflight -> author -> clean verify -> READY
-> one human batch approval -> paced push/PR
-> asynchronous receipt, attestation, and outcome reconciliation
```

Local preparation must continue while public GitHub publication is paused, unless the underlying machine or model provider itself is unavailable.

## Complexity budget

Before adding code, ask:

1. Can existing code be deleted or simplified instead?
2. Can this be a function instead of a class or subsystem?
3. Can in-memory/local state replace another persistent file or table?
4. Can a warning or metric replace a gate?
5. Can asynchronous reconciliation replace a precondition?
6. Is this protecting a demonstrated failure, or only an imagined one?

Default limits for one task:

- zero new daemons, schedulers, approval types, state machines, databases, or policy languages;
- zero new persistent state files unless persistence is essential to crash recovery or public-byte binding;
- at most one new production module;
- keep non-mechanical changes under roughly 500 lines; split larger work into the smallest usable stage;
- for simplification tasks, production code should decrease overall. If it grows, stop and justify why the smaller design is impossible.

Deletion does not count against the change-size limit.

## Model and reasoning discipline

- Use the lowest-capability/effort mode that can produce a mechanically verifiable result.
- Routine implementation should not default to `xhigh`, `max`, `ultra`, multi-agent review, or repeated architecture exploration.
- Use stronger reasoning only for a concrete cross-cutting integrity problem, difficult root-cause analysis, or an explicitly requested design review.
- Sol is an implementation tool in this repository, not an autonomous governance architect unless the user asks for architecture work.
- Do not create parallel reviewers or subagents by default. One agent should inspect, implement, and verify the bounded change.
- Stop after the acceptance condition passes. Do not continue searching for optional improvements.

## Editing rules

Before editing:

- State the smallest observable success condition.
- Find the active call path and focused tests with `rg`.
- Read only the files needed for that path.
- Ignore historical plans and archived implementations unless the task names them.

While editing:

- Prefer direct code over wrappers, registries, factories, adapters, and configuration layers.
- Do not add an abstraction with one caller.
- Do not add configurable knobs without a current second use case.
- Do not preserve obsolete behavior merely because tests encode it; remove or update obsolete tests.
- Keep public claims, comments, and PR text accurate to what was actually run.
- Never commit, push, open a PR, post a comment, merge, publish, or change remote state unless explicitly authorized.

## Testing rules

- Run the narrowest relevant test first, for example:

```sh
node --test path/to/changed.test.mjs
```

- Run the full root suite only when changing shared core behavior, publication safety, GitHub safety, or when explicitly requested:

```sh
node --test *.test.mjs
```

- Add tests for externally observable behavior, important failure recovery, and the specific regression.
- Do not add exhaustive matrices for constants, prose, schemas, aliases, internal serialization details, or speculative edge cases.
- A normal change usually needs one happy-path regression and one meaningful failure-path test—not dozens of policy tests.
- When deleting a gate or feature, delete its dedicated tests and documentation instead of preserving a dormant compatibility path.
- Do not add a formatter, linter, test framework, or dependency if the repository does not already use it.

## Candidate and authoring path

- Reuse the existing candidate lake; do not crawl broadly when enough candidates already exist.
- Hydrate only candidates about to enter workers, then recheck again before public submission.
- Prefer deterministic mechanical preflight plus speculative local execution over a long mandatory model qualification.
- Default to direct authoring with one bounded fix-and-test loop.
- After one useful verifier failure, allow one corrected author attempt. Standard-lane tasks should then fail or skip cleanly rather than spawning an open-ended review loop.
- Keep pilot profiles isolated from the proven production lane; a pilot failure must not stop Node production work.
- Assign public mission IDs when a verified item becomes READY, not for every failed local attempt.

## Human review and publication

- Generate a review board when enough READY items exist or the oldest item has waited a short configurable interval; never wait for a shift or scheduled board time.
- Present concise cards: issue, summary, diffstat, risk flags, changed files, base/patched observations, declared checks, exact PR title/body, and receipt claim.
- One human may approve any subset of 10–30 items with one digest-bound batch approval.
- Revalidate each item immediately before public action. A stale item should be removed or regenerated without blocking clean items.
- Open the approved upstream PR after exact-byte validation and the final live recheck.
- Receipt attestation, Pages rendering, ledger envelopes, and later outcome updates should reconcile asynchronously and idempotently.

## GitHub account protection

- Treat API limits as technical ceilings, not permission for bulk activity.
- Batch read-only GraphQL work, use existing local data, and avoid repeated polling.
- Serialize and pace mutations. Never retry a secondary-limit or abuse response automatically.
- Default to no issue-claim comment unless repository policy requires one.
- Respect one-open-PR-per-repository and cooldown rules unless a maintainer explicitly authorizes more.
- Prioritize maintainer replies, corrections, and withdrawals over new submissions.
- Never evade limits through account rotation, identity sharding, or alternate credentials.

## Completion report

When done, report only:

- the behavior changed;
- files changed or deleted;
- focused tests run and results;
- complexity removed or introduced;
- any concrete unresolved risk.

Do not produce a new roadmap, governance proposal, or list of optional enhancements unless requested.
