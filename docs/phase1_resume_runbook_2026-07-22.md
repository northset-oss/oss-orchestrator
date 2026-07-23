# Phase 1 Resume Runbook — the Level-1-integrated machine (2026-07-22)

Audience: the operating team resuming Phase 1 execution. This is an operator synopsis, not a second
source of runtime policy. The active `factory/` code and `OPERATING_CONTRACT.md` are canonical for
the orchestrator. For foreign-code execution, consent, and publication boundaries, the canonical
sources are the active `northset-oss` code plus `docs/foreign-production-runner.md`,
`docs/run-request-intake.md`, and `docs/foreign-run-gate-evidence-2026-07-22.md` in that repository.
If this runbook disagrees with any of those sources, follow the code and canonical document and fix
this runbook. Historical campaign plans and archived material are context only and are not current
machine authority.

## 0. Where the machine is right now (verified 2026-07-23T19:25:29Z)

This section is a time-bound observation, not authority. The continuous runner, GitHub outcomes, and
receipt reconciliation can change it immediately. Re-query the database, board, GitHub status, and
remote refs before acting.

- **The active orchestrator code is green.** Local `oss-orchestrator/main` is at
  `a4d47a4cea7b307e781ca84cae1a012667221308`. The complete factory suite passed 249/249,
  including the real Docker test that detects tracked and untracked mutations in the verifier's
  container copy. The focused worktree changes described below are not part of that commit yet.
- **The fetched public-ledger authority is current at the recorded refs.** In `northset-oss`, fetched
  `origin/main` is `0c011e6b33f79d7345f55eac49e4f0624a93536e` and contains the amended-disclosure
  verifier through commit `2953abb9827a79edaef8cd51f1c35c243ea56ee3`. Fetched
  `origin/receipts` is `25d19e7c36c729e4020bdc79ab878c5f9f96ec74`. The local checkout is
  intentionally not used as authority while its separate M-004 renderer correction is dirty.
- **The authored factory is running.** PID 32131 started at `2026-07-23T18:24:38Z` with eight Node
  workers. At this snapshot it has 0 queued tasks, 2 working tasks, 2 pending READY items, and one
  open board. The database contains 931 tasks and 44 submitted, published, and attested missions.
- **The open board is held, not approval-ready.** Board
  `sha256:4e9ca8215da7d98329fda2f5568c07f03f8de0fa55a49daa0fe9f53d93664ef4`
  contains M-1070 and M-1068. Each target repository already has one open Northset PR, and each held
  patch overlaps that active PR. Keep the board pending until the active PR resolves, then refresh and
  reverify against the resulting base before asking for approval.
- **Level 1 orchestrator infra is merged to `oss-orchestrator` main:** convertibility targeting,
  rejection harvesting, the `dossier` command, the demand records, and the finalized offer-message
  catalog (`factory/offer-messages.mjs`).
- **Level 1 verification infra is merged to `northset-oss` main:** the V (verifier) lane, the M-004
  sample receipt, the maintainer request CTA, the sacrificial-boundary acceptance suite, and
  `bin/foreign-runner.mjs`. M-004 is a publicly visible `prepared` rehearsal, not an external
  maintainer verification; see §5 for its corrected interpretation.
- **The foreign-code boundary gate is signed off GO.** See
  `northset-oss/docs/foreign-run-gate-evidence-2026-07-22.md`: all 9 checklist items PASS, a 71/71
  production Docker battery passed in a disposable micro-VM, and the decision is **GO for consent-first
  foreign-PR offers**. This authorization is per-PR and conditional; read §4 before using it.
- **The live, read-only dossier refresh completed at `2026-07-22T21:50:49.946Z`.**
  `offer_dossiers.json` has 20 warm repos, 13 named PRs, 13 attached drafts, and one harvested
  verification prospect. `offer_funnel.jsonl` has 13 `identified` plus 13 `offer_drafted` records;
  `icp_log.jsonl` has 20 records. No message was sent and no GitHub state was mutated.
- **The public ledger snapshot used by the dossier has 73 receipts:** 69 contributor self-run receipts
  and four rehearsals. Its recorded upstream states are 37 open, 24 merged, seven closed unmerged,
  one changes requested, and one prepared; three receipts have no upstream state. It was generated at
  `2026-07-22T18:43:22Z`.
- Host prerequisites for foreign runs are present: `sbx v0.35.0`, an empty sbx secret store, a
  deny-all network policy, and the pinned executor image. These are readiness facts, not consent for
  any candidate run.

## 1. The guardrails that still bind (read before touching anything)

These do not change for Level 1. A single violation is more costly than any amount of throughput.

- **Account survival first.** All GitHub-facing actions go through Aysajan's account. A 403/429,
  `Retry-After`, secondary-limit or abuse message, platform warning, or account restriction stops the
  GitHub queue. Do not hammer retries. Resume only by explicit decision via `github-resume`.
- **One human gate for public authored work:** a content-bound approval over exact READY items, then an
  explicit `publish`. Approval performs no GitHub action; `publish` is the only authorization to act.
- **No credential ever enters a repository, author, verifier, or foreign container.** This is the
  identity of the company.
- **Nothing runs on someone else's code without a recorded, PR-scoped consent artifact.** Consent for
  one PR is never consent for another. A stop or withdrawal halts work immediately and is never treated
  as continuing consent.
- **Publication is always separate and human-authorized**, for both authored receipts and any
  verification receipt. Private-by-default is the rule for verification results.
- **Honest claims only.** Contributor self-run evidence is not maintainer verification, security review,
  or a code-quality guarantee.

## 2. Stream A — resume the authored loop (this is still the spine)

The core loop is unchanged in shape. The Level 1 changes ride inside it automatically (§2.3).

### 2.1 Top up supply, then run

```sh
# Only when Node candidate supply is low. Bounded, safety-queued, max 100 fresh candidates.
node factory/cli.mjs discover --target 64

# Always-on preparation. Ctrl-C / SIGTERM stops cleanly. --once is diagnostic only.
node factory/cli.mjs run --profile node --workers 8 --board-size 20 --board-max-age-minutes 30
```

`run` selects candidates, does live preflight, prepares and verifies patches locally, builds an
immutable board on size/age, and performs a bounded PR/CI/attestation reconciliation at startup and
every 15 minutes without blocking local work.

### 2.2 Review, approve, publish (the human gate)

```sh
node factory/cli.mjs board                                   # show the current immutable board
node factory/cli.mjs approve --board sha256:<digest> \
  --ids M-201,M-204 --reject-ids M-203                        # approve exact items only
node factory/cli.mjs publish --board sha256:<digest>          # the only public authorization
```

Approve Green items together; select Amber individually; Red cannot be approved by the scaled lane.
Re-running `publish --board <digest>` is the crash-recovery path and never duplicates PRs. When
`run` is stopped, `node factory/cli.mjs reconcile --limit 30` performs the same bounded reconciliation
and prints current maintainer follow-up facts.

### 2.3 What Level 1 changed inside Stream A (automatic, no new commands)

- **Convertibility targeting (candidate ranking).** `run` now ranks candidates not only by fix-ability
  but by Level-1 convertibility, using offline signals: organization-owned repos rank above personal
  user repos, healthy-star and recently-active repos rank higher, archived/low-star personal repos are
  deprioritized (never excluded), and repos/owners where Northset already has a merge get a
  relationship boost. Caps are unchanged. You do not run anything extra; selection is simply better
  aimed. Prefer letting relationship repos accumulate second and third merges.
- **Rejection harvesting (outcome reconciliation).** When a PR is closed unmerged or changes are
  requested, `reconcile`/`run` classify a reason code. If the maintainer signalled an AI-policy concern
  or that patches are not wanted, that owner is recorded as a verification prospect and added to a
  do-not-author pause list. Candidate selection then skips further authored PRs to that owner. This is
  telemetry plus a skip rule, never a blocking gate. The effect: we stop pushing patches at maintainers
  who told us to stop, and we remember them as verification prospects for §3.
- **Demand records emit during reconciliation.** Terminal missions append `shadow_acceptance.jsonl`
  (would payment have released) and, when a merge happens with no maintainer CI rerun,
  `proto_signals.jsonl` (de-facto delegation). These files appear under `runs/demand/` after the first
  reconcile over a terminal mission.

## 3. Stream B — the Level 1 offer funnel (the new work)

This is the demand-generation line. It runs alongside Stream A. The governing rule from the campaign is
one individualized message per relationship, no follow-up without engagement.

### 3.1 Refresh the dossier (bounded live reads, local writes only)

```sh
node factory/cli.mjs dossier --limit 30
```

This is not an offline command. It reads the live public ledger and the local factory DB for warm
(previously merged) repos, then pulls each repo's open-PR queue read-only through the GitHub safety
queue. It performs no GitHub mutation and sends no outreach. It ranks PRs by verification pain (a
fork PR from a first-time contributor stuck before CI is top), harvests rejected-PR reasons into
verification prospects, and writes only local artifacts:

- `runs/demand/offer_dossiers.json` — per warm repo: the single best PR to name, its "why it hurts",
  runners-up, and now a personalized `draft_message` (see §3.2).
- `runs/demand/offer_funnel.jsonl` — append-only `identified` and `offer_drafted` entries for each
  named PR whose dossier draft was generated. Existing later stages are never regressed.
- `runs/demand/icp_log.jsonl` — who asked / who is reachable.

Run this before operator review when the live PR facts need refreshing. The current refresh is already
complete: 20 warm repos, 13 named PRs, and 13 drafts. Re-running is idempotent for existing funnel
stages, though a newly selected PR receives its own new offer ID and first two stage records.

### 3.2 The offer messages (finalized copy, no em dashes, personalization enforced)

The canonical send-able copy lives in `factory/offer-messages.mjs`. Five messages, each requiring its
personalization slots so nothing goes out generic:

| Key | When | Sendable status |
| --- | --- | --- |
| `self_verify` | In an open PR thread on one of our own fork PRs, to help the maintainer see green before approving CI | **Send now** (ungated, our own code) |
| `issue_choice` | With an already-engaged maintainer, to let them pick the next fix | **Send now** (ungated) |
| `post_merge` | Within 48h of a merge, offering to verify a stuck contributor PR | **Now allowed** under §4 (foreign code) |
| `rejection_harvest` | To a maintainer who declined our patches, offering verification instead | **Now allowed** under §4 (foreign code) |
| `affordance` | Passive line on receipt pages and the org README | UI copy, not an outbound message |

`post_merge` and `rejection_harvest` are marked `foreign_code: true` in the catalog. The
sacrificial-boundary block that previously gated the offers was signed off GO on 2026-07-22, so
`send_gated` is `false`. That means a reviewed, individualized consent-first offer may be sent before
consent in order to ask for consent. It does **not** authorize running code. The drafts carry the
canonical requirement `recorded PR-scoped maintainer consent before foreign-runner run`, matching the
`northset-oss` gate and intake documents. The `post_merge` draft is attached automatically to each
dossier entry, personalized from the PR's own facts. Render the always-safe ones directly, for example:

```sh
node factory/offer-messages.mjs self_verify
node factory/offer-messages.mjs issue_choice
node factory/offer-messages.mjs rejection_harvest --maintainer <login>
```

Always read the rendered message before sending and personalize the one specific detail so it never
reads as a template.

### 3.3 Track every offer through the funnel (append-only)

```sh
# Log a manually-initiated offer (self-verify in a PR thread, or an issue-choice ask):
node factory/offer-dossier.mjs identify \
  --repo owner/name --pr-number 123 --offer-type self_authored_verify --maintainer <login>

# Advance a manual offer as reality changes (never edit prior lines; always append):
node factory/offer-dossier.mjs advance --offer-id OF-owner/name-123 --stage offer_drafted
node factory/offer-dossier.mjs advance --offer-id OF-owner/name-123 --stage offer_sent
```

The successful path is `identified` → `offer_drafted` → `offer_sent` → `yes` → `run_delivered` →
`five_questions_recorded` → `second_invocation`. `declined` and `no_response` are terminal branches
from `offer_sent`; `declined` also records consent withdrawn after `yes`. The CLI rejects skipped,
backward, duplicate, and post-terminal transitions before appending anything. After any delivered run,
record the five demand questions in the operator record and advance to `five_questions_recorded`:
did it change what you inspected; did it save a rerun; did it speed a decision; would you invoke again;
what blocks automatic use. The metric that matters is **second voluntary invocation**, not compliments.

## 4. Foreign-PR verification — the consent-first procedure (now GO, still strict)

Use this execution procedure only after §3 produced an offer, the maintainer consented to a specific
PR, and you have read `northset-oss/docs/foreign-run-gate-evidence-2026-07-22.md`. Sending the
consent-first offer itself does not require prior consent; executing the candidate does. The GO is
per-PR and conditional.

1. **Record consent, PR-scoped.** Follow `northset-oss/docs/run-request-intake.md`. Confirm the request
   names a public PR and repo, the requester is a maintainer or authorized representative, the declared
   checks, and the private-by-default return channel. Bind the retained consent artifact to the run
   input before any code runs. A `northset-verify` label only counts on an onboarded repo.
2. **Build the executor config** bound to the exact base commit and (if any) approved patch, node
   profile, the exact pinned image, `workspace_mode: readonly`. Compute its sha256.
3. **Run only through the foreign runner.** From a clean `northset-oss` checkout on the host with
   `sbx >= 0.35.0`, a deny-all sandbox policy, and an empty sbx secret store:

   ```sh
   node bin/foreign-runner.mjs run <executor-config.json> \
     --config-sha256 sha256:<hex> \
     --source-commit <40-hex> \
     --patch-sha256 sha256:<hex|none> \
     --out <empty-dir>
   ```

   The runner creates a disposable micro-VM, isolates the network (npm registry allowed; GitHub,
   OpenRouter, cloud metadata `169.254.169.254`, and LAN denied), enforces a hard tmpfs byte/inode cap,
   does quiescent immutable intake of the exact commit, runs the containment battery, verifies the
   staged input digests, executes the declared checks, copies out only `run_record.json` / `stdout.txt`
   / `stderr.txt`, and destroys the micro-VM.
4. **Honor the decision literally.** Success is `"decision": "GO_AND_EXECUTED"`. **Any other result,
   including `NO-GO`, means do not use the output.** Never hand-run foreign code outside this path.
5. **Deliver privately, then stop.** Return the scoped run record to the requester privately. A public,
   signed V receipt is a separate, affirmative, human-authorized publication step that names the record.
   Never publish on the basis of the request form alone. A stop or withdrawal halts everything and does
   not carry to another PR.

`node bin/foreign-runner.mjs gate` re-proves the infrastructure (decision `INFRASTRUCTURE_GO`) without
executing any candidate. Use it to re-confirm the boundary after any host or runner change.

Reporting discipline: only maintainer-authorized verification counts toward the demand goal.
Verification of a PR Northset itself authored is still Level 1 (the owner asked), but report it as
verification-of-own-authored-PR, separate from third-party verification.

## 5. The V-lane sample (M-004) and the request affordance

- `northset-oss/missions/M-004` is the self-authorized V-lane rehearsal sample, state `prepared`, and
  is already publicly visible as the linked sample receipt. It is unsigned and unattested, no pull
  request was opened, and no external maintainer requested it; it is not external validation. The
  original immutable consent described preparation of an unpublished sample. Do not rewrite that
  historical evidence. The mutable `publication.json` now carries the public correction and scope
  interpretation, and the generator-derived ledger/site projections match it locally.
- The maintainer CTA on every receipt page and repo page already links a sample private-check receipt.
  This is your ambient ask; no per-mission action is needed.

## 6. Weekly scoreboard (what to report, and what not to)

Report, in this order: authorized verification runs and second invocations; shadow decisions recorded
and their would-release accuracy; offers made, yeses, and runs delivered; operator-free rate; incidents
(must be zero). Do **not** headline raw receipt count. Receipts are fuel; delegated decisions with
stakes are the product. The strategic target remains the campaign's Phase 1 exit gate (three
consecutive clean 24h periods at the shipped-per-day and first-pass-yield thresholds), but per the
operating contract no outcome metric blocks local work.

## 7. What not to do

- Do not batch or template outreach, and never follow up without engagement.
- Do not run any foreign code outside `foreign-runner.mjs run`, and do not treat any non-`GO_AND_EXECUTED`
  result as usable.
- Do not execute any candidate named by a `post_merge` or `rejection_harvest` offer until recorded,
  PR-scoped maintainer consent exists. Sending the individualized consent-first offer is allowed.
- Do not publish any receipt, authored or verification, without a separate human authorization.
- Do not author more patches at an owner on the do-not-author list; offer verification instead.
- Do not count contributor-requested runs as maintainer-authorized; report them separately.
- Do not re-order or edit demand JSONL lines; the funnel and logs are append-only.

## 8. Command quick reference

```text
# Authored loop (oss-orchestrator)
node factory/cli.mjs discover --target 64
node factory/cli.mjs run --profile node --workers 8 --board-size 20 --board-max-age-minutes 30
node factory/cli.mjs board
node factory/cli.mjs approve --board sha256:<digest> --ids <M-…> [--reject-ids <M-…>]
node factory/cli.mjs publish --board sha256:<digest> [--repository-open-override <M-…>]
node factory/cli.mjs reconcile --limit 30
node factory/cli.mjs github-status
node factory/cli.mjs github-resume --reason "<decision>" [--repository owner/repo]

# Level 1 offer funnel (oss-orchestrator)
node factory/cli.mjs dossier --limit 30
node factory/offer-messages.mjs <self_verify|issue_choice|rejection_harvest --maintainer LOGIN|affordance>
node factory/offer-dossier.mjs identify --repo owner/name --pr-number N --offer-type <type> --maintainer LOGIN
node factory/offer-dossier.mjs advance --offer-id OF-owner/name-N --stage <stage> [--note "…"]

# Foreign verification + V lane (northset-oss)
node bin/foreign-runner.mjs gate
node bin/foreign-runner.mjs run <config.json> --config-sha256 sha256:<hex> --source-commit <40hex> --patch-sha256 <sha256:hex|none> --out <empty-dir>
node bin/rehearse-v-lane.mjs
```

## 9. First moves on resume (concrete)

1. Re-query current status. At the snapshot in §0 the continuous runner is active, two tasks are
   working, and the only open board is deliberately held by repository-open caps. Do not approve or
   publish that stale snapshot.
2. The live dossier refresh is complete. An operator should review the 13 attached drafts and current
   PR facts before choosing any individualized offer. This runbook update did not authorize sending.
3. When outreach is explicitly authorized, send only the selected individualized offers and advance
   each funnel record from `offer_drafted` to `offer_sent`. Do not batch or automatically follow up.
4. Keep the existing Stream A runner alive while it is healthy. Start another `run` only after the
   current run lock is released. Public authored work still requires the exact board approval and
   explicit `publish` command in §2.2.
5. Only after recorded PR-scoped consent, run `foreign-runner.mjs run`, deliver privately, and record
   the five questions. Treat publication as a separate human decision.
6. Report the week by the §6 scoreboard. Watch for second voluntary invocations; that is the signal
   that Level 1 demand is real.
