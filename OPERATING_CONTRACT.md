# OSS factory operating contract

## Authority boundary

Everything private, local, reversible, and non-public runs autonomously. The only routine human gate
is one content-bound approval over exact READY items before public GitHub publication. Clearing a
GitHub secondary-limit hold or a maintainer repository cooldown also requires an explicit operator
reason.

The active production modules are only those under `factory/`. Files under `archive/` are historical
records and must not be imported by the active runtime.

## Active flow

```text
DISCOVERED -> QUEUED -> WORKING -> VERIFIED -> READY
                                      READY -> APPROVED -> PR_OPENED -> RECEIPT_ATTESTED
```

Terminal or side states are:

```text
SKIPPED
FAILED
REJECTED_BY_OWNER
SUPERSEDED
PUBLICATION_PAUSED
```

`task_id` is stable for one `owner/repository#issue`. Local retries remain attempt rows under that
task. A public `mission_id` is allocated only when a verified result enters READY. Failed local work
does not consume mission IDs.

## Autonomous local work

The factory may continuously perform candidate selection, live preflight, checkout, dependency
bootstrap, source scouting, authoring, one bounded retry, clean verification, risk classification,
artifact persistence, PR drafting, READY creation, board generation, and stale-item refresh.

The normal production profile is Node. Python, Go, and Rust are not activation or exit gates. No
shift, wall-clock window, NTP observation, handoff, calibration sample, profile graduation, or outcome
metric may block local work.

## Hard integrity invariants

1. No host credential, including GitHub or Codex authentication, enters repository, author, or
   verifier containers. The authenticated model client stays outside that boundary.
2. Dependency bootstrap is credential-free; frozen dependency material is read-only afterward.
3. Final verification is network-off and binds the patch, tested tree, DCO commit, published branch,
   and PR head to the same approved bytes.
4. Receipt claims are typed and limited to what the base and patched observations establish.
5. The issue must remain open, invited, and unoccupied at work start and immediately before public
   submission.
6. One open Northset PR per repository, repository cooldowns, owner/hour/day limits, and maintainer
   opt-outs are blocking publication controls.
7. A rate limit, abuse response, platform warning, or account restriction stops the GitHub queue
   immediately. It does not stop queued local preparation.
8. Claim comments are not part of the normal path.

## Attempts and risk

Infrastructure receives one automatic retry for recognized transient Docker, clone/fetch, package
registry, and local filesystem failures. The retry stays inside the same attempt record. The first
author or verifier failure is passed verbatim to one second author attempt. A second failure skips the
task in the standard lane.

Green and Amber results may enter READY. Red work is skipped by the scaled lane. Risk cannot be
downgraded by model output; it is derived again from verified changed files, diff size, and warnings.

## Boards and approval

A board is created when the configured READY count is reached, the oldest READY item reaches the
configured age, the maximum is reached, or the operator runs `board`. There is at most one OPEN board
at a time.

The immutable board binds each mission's target, patch and manifest digests, commit/tree, checks,
exact PR title/body, receipt claim, and planned public actions. The operator may approve a subset,
reject a subset or reject the complete board. Unspecified items return to READY. A mutation or clean
base refresh invalidates only the affected item and requires a new board approval. Approval and
publication both reread the durable patch and repository to prove those review links still bind the
stored base, commit, and tested tree.

Approval itself performs no GitHub action. `publish --board <digest>` is the explicit authorization to
execute only the approved public plan.

## Publication and safety

The publisher, in order:

1. validates the immutable board and owner approval;
2. performs a final live collision, claimant, opt-out, issue-state, and base-state check;
3. publishes one immutable receipt batch bound to the approval digest;
4. pushes the exact approved commit without force;
5. creates or adopts the exact upstream PR;
6. reads the PR back and verifies title, body, base, and head OID;
7. records `SUBMITTED` and leaves attestation/status reconciliation asynchronous.

Public actions pass through one serialized safety queue. Mutations are spaced, public contribution
caps are enforced, primary exhaustion waits for reset, and transient network/5xx failures receive one
bounded retry. A secondary-limit pause requires its cooldown plus one explicit `github-resume` action
and one probe. An account restriction has no local resume path.

## Recovery semantics

- Factory startup recovers interrupted WORKING tasks into the queue and closes the interrupted
  attempt without a mission ID.
- The always-on loop contains recoverable source failures and continues draining local work.
- Publication is checkpointed and idempotent. Re-running the same board adopts exact existing
  branches and PRs and never creates duplicates.
- Clean base movement triggers rebase/reverification and item-only reapproval. Conflicts or failed
  re-verification preserve approved bytes and return a recoverable result.
- Receipt attestation or final status failure never closes or duplicates an already opened upstream
  PR. The always-on process performs bounded reconciliation every 15 minutes, publishes factual
  `publication.json` updates in one batch, and resumes from the stored publication state.

## Commands

The complete routine operator surface is:

```sh
node factory/cli.mjs run --profile node --workers 8 --board-size 20 --board-max-age-minutes 30
node factory/cli.mjs board
node factory/cli.mjs approve --board sha256:<digest> --ids M-201,M-202
node factory/cli.mjs publish --board sha256:<digest>
node factory/cli.mjs github-status
node factory/cli.mjs github-resume --reason "<founder decision>"
```

Repository cooldown release uses the same recovery command with `--repository owner/repository`.
Paths, defaults, prerequisites, and the reject-all form are documented in [README.md](README.md).

## Metrics and non-goals

READY per lane-hour, latency, yield, API efficiency, and human review time are operational targets and
alerts, never authorization gates. Python/Go/Rust graduation, app or marketplace work, private
repository support, cost-accounting completeness, corpus/reporting work, and reviewer-calibration
research are outside this active contract.
