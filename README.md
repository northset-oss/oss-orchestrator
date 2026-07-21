# Northset OSS contribution factory

This repository runs an always-on, Node-only preparation factory. Local and reversible work is
autonomous. Opening upstream pull requests is the single human-authorized boundary: an operator
reviews an immutable READY board, approves exact mission IDs, and explicitly starts the paced
publisher.

The binding runtime policy is [OPERATING_CONTRACT.md](OPERATING_CONTRACT.md). The redesign rationale
is [docs/oss_orchestrator_system_redesign_2026-07-19.md](docs/oss_orchestrator_system_redesign_2026-07-19.md).
Phase-level observations and carry-forward lessons are recorded in
[docs/phase1_learnings.md](docs/phase1_learnings.md).
The retired campaign-v3 runtime is preserved under [archive/campaign-v3](archive/campaign-v3/) and is
not part of the active path.

## Prerequisites

- Node.js 24, Git, Docker, and GitHub's `gh` CLI.
- `gh` authenticated as the intended contributor for live preflight and publication.
- Host Codex authentication available through `CODEX_ACCESS_TOKEN` or `CODEX_HOME`. The authenticated
  model client runs in the host Codex sandbox; credentials are never mounted into repository or test
  containers.
- The default candidate lake at `candidate_lake.sqlite`, or an alternate `OSS_FACTORY_LAKE`.
- Push access to the receipt repository before using `publish`.
- The pinned Node dependency/verifier image expected by the worker. Build it once with:

```sh
docker build --pull --tag northset-oss-author:0.144.1 \
  --file author-image/Dockerfile author-image
```

## Normal operation

Run the private factory continuously:

```sh
node factory/cli.mjs run \
  --profile node \
  --workers 8 \
  --board-size 20 \
  --board-max-age-minutes 30
```

The process selects only enough lake candidates to maintain queue depth, performs live preflight,
prepares and verifies patches locally, and creates an immutable board when the size or age threshold
is reached. It also performs a bounded asynchronous PR/CI/attestation reconciliation pass at startup
and every 15 minutes without blocking local work. `Ctrl-C` or `SIGTERM` stops it cleanly. `--once` is
available for a bounded diagnostic cycle; it is not the production mode.

In another terminal, display the current board:

```sh
node factory/cli.mjs board
```

When the always-on process is stopped, run the same bounded PR/CI/attestation pass and print current
maintainer review, comment, and thread facts without starting workers:

```sh
node factory/cli.mjs reconcile --limit 30
```

The follow-up summary is an ephemeral snapshot. It reports truncated GitHub history explicitly and
does not infer that a request was addressed or post any response.

Each card shows the repository and issue, risk, changed files and diffstat, links to the full local
diff and verifier log, base and patched observations, exact checks, exact PR title/body, and receipt
claim.

Approve only the exact items reviewed. Green items may be approved together; Amber items should be
selected individually. Explicitly rejected items become owner-rejected. Items omitted from both
lists return to the READY pool for a later board.

```sh
node factory/cli.mjs approve \
  --board sha256:<digest> \
  --ids M-201,M-202,M-204 \
  --reject-ids M-203
```

To reject every item, omit `--ids` and provide all IDs with `--reject-ids`. Red items cannot be
approved by the scaled lane. Approval rereads the durable patch and Git repository and verifies the
base, patch digest, commit, and tested tree shown on the board. A changed manifest or artifact
invalidates only that item's approval and sends it back for review.

Publication is a separate, explicit command:

```sh
node factory/cli.mjs publish \
  --board sha256:<digest>
```

When the owner explicitly overrides only the one-open-PR-per-repository cap for one approved mission,
bind that exception to the mission on the approved board:

```sh
node factory/cli.mjs publish \
  --board sha256:<digest> \
  --repository-open-override M-201
```

The override does not bypass approval, live issue eligibility, collision checks, repository cooldowns,
or owner/hour/day publication caps.

It validates the approval, performs the final live collision/occupancy check, publishes one immutable
receipt batch, pushes exact approved commits, opens upstream PRs through the paced safety queue, and
reads each PR back to verify its stored title, body, base, and head OID. Re-running the same command
is the supported crash-recovery path; exact existing branches and PRs are adopted instead of
duplicated.

## GitHub safety

Inspect safety state without making a GitHub request:

```sh
node factory/cli.mjs github-status
```

A secondary limit or abuse response stops the GitHub queue and writes one pause record. Local queued
work continues, but no new live preflight occurs while GitHub is paused. After the recorded cooldown
and an explicit owner decision, clear the hold with exactly one recovery probe:

```sh
node factory/cli.mjs github-resume \
  --reason "<founder decision>"
```

Platform account restrictions cannot be cleared locally. A repository-specific maintainer cooldown
is separate and can be cleared only after review:

```sh
node factory/cli.mjs github-resume \
  --repository owner/repo \
  --reason "<maintainer or founder decision>"
```

## Defaults and environment

| Setting | Default | Override |
| --- | --- | --- |
| Factory database | `runs/factory/factory.sqlite` | `--db`, `OSS_FACTORY_DB` |
| Candidate lake | `candidate_lake.sqlite` | `--lake`, `OSS_FACTORY_LAKE` |
| GitHub pause record | `runs/factory/github-pause.json` | `--pause-file`, `OSS_FACTORY_PAUSE_FILE` |
| Worker scratch root | `runs/factory/work` | `--work-root`, `OSS_FACTORY_WORK_ROOT` |
| Durable artifacts | `runs/factory/artifacts` | `--artifact-root`, `OSS_FACTORY_ARTIFACT_ROOT` |
| Worker executable | `factory/node-worker.mjs` | `--worker-command`, `OSS_FACTORY_WORKER_COMMAND` |
| Receipt remote | `https://github.com/northset-oss/verification-pilot.git` | `--receipt-remote`, `OSS_FACTORY_RECEIPT_REMOTE` |
| GitHub executable | `gh` | `--gh-bin`, `GH_BIN` |
| Approval identity | `internal-user:aeziz` | `--approved-by`, `--cleared-by`, `OSS_FACTORY_APPROVED_BY` |
| Fork owner | `AysajanE` | `OSS_FACTORY_FORK_OWNER` |
| Dependency/verifier image | `northset-oss-author:0.144.1` | `OSS_AUTHOR_IMAGE` |
| Author model | `gpt-5.6-sol` | `OSS_FACTORY_AUTHOR_MODEL` |

Run defaults are eight workers, a 20-item board, a 30-minute board age, a five-second idle poll, and
a candidate preflight target of twice the worker count, capped at four times the worker count.

## Recovery and reconciliation

- `run` automatically closes interrupted WORKING attempts and requeues their tasks without assigning
  a public mission ID.
- A GitHub pause or recoverable source failure does not stop already-queued local work.
- Re-run `publish --board <digest>` after interruption. Publication checkpoints prevent duplicate
  pushes and PRs.
- A clean base refresh keeps the mission ID, regenerates verified bytes, and returns only that item to
  READY for fresh approval. A conflict leaves the item recoverable without changing approved bytes.
- `SUBMITTED` means the upstream PR exists and its stored bytes/head were verified. Receipt
  attestation and later PR/CI outcome publication are asynchronous. The always-on `run` process uses
  `reconcilePublicationBatch()` to update `publication.json`, retry pending attestations, and release
  the one-open-PR reservation after merge or closure. `reconcile` performs the same bounded pass when
  `run` is stopped and also prints current follow-up facts. Failure leaves the upstream PR open and
  recoverable and never creates a replacement PR.

There is no shift activation, JIT window, NTP gate, profile-exit gate, reviewer-calibration gate,
scheduled board, claim-comment step, or per-mission signature command in the active runtime.
