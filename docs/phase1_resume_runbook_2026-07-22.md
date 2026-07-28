# Phase 1 Resume Runbook — the Level-1-integrated machine (2026-07-22)

Audience: the operating team resuming Phase 1 execution. This is the accurate, precise procedure for
running the machine as it stands today, including the Level 1 additions. It layers on top of, and does
not replace, `OPERATING_CONTRACT.md` (binding runtime policy) and `README.md` (core command
reference). Where this runbook and the contract ever disagree, the contract wins.

## 0. Where the machine is right now (verified 2026-07-22)

- **Both repos are on `main` and green.** `oss-orchestrator` factory suite: 240/240. `northset-oss`
  suite: 304 pass, 0 fail, 10 Docker-gated skips (the skips run only inside the foreign-runner micro-VM).
- **Level 1 orchestrator infra is merged to `oss-orchestrator` main:** convertibility targeting,
  rejection harvesting, the `dossier` command, the demand records, and the finalized offer-message
  catalog (`factory/offer-messages.mjs`).
- **Level 1 verification infra is merged to `northset-oss` main:** the V (verifier) lane, the M-004
  sample receipt (state `prepared`, unpublished), the maintainer request CTA, the sacrificial-boundary
  acceptance suite, and `bin/foreign-runner.mjs`.
- **The foreign-code boundary gate is signed off GO.** See
  `northset-oss/docs/foreign-run-gate-evidence-2026-07-22.md`: all 9 checklist items PASS, a 71/71
  production Docker battery passed in a disposable micro-VM, and the decision is **GO for consent-first
  foreign-PR offers**. This authorization is per-PR and conditional; read §4 before using it.
- **The team has already run one `dossier` pass.** `runs/demand/` holds `offer_dossiers.json` (18 warm
  repos, 11 named PRs), `offer_funnel.jsonl` (11 offers at stage `identified`), and `icp_log.jsonl`
  (18 entries). Those 11 dossier entries were generated before the draft-message wiring landed, so they
  have no `draft_message` yet. Re-run `dossier` (§3.1) to regenerate with the personalized drafts attached.
- Host prerequisite for foreign runs is present: `sbx v0.35.0` on PATH.

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

### 3.1 Generate the dossier (offline read of warm relationships)

```sh
node factory/cli.mjs dossier --limit 30
```

This reads the public ledger and the factory DB for warm (previously merged) repos, pulls each repo's
open-PR queue read-only through the safety queue, ranks PRs by verification pain (a fork PR from a
first-time contributor stuck before CI is top), harvests rejected-PR reasons into verification
prospects, and writes:

- `runs/demand/offer_dossiers.json` — per warm repo: the single best PR to name, its "why it hurts",
  runners-up, and now a personalized `draft_message` (see §3.2).
- `runs/demand/offer_funnel.jsonl` — one `identified` entry per named PR (append-only funnel).
- `runs/demand/icp_log.jsonl` — who asked / who is reachable.

Re-run `dossier` now so the existing 11 offers gain their `draft_message`.

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
sacrificial-boundary block that previously gated them was signed off GO on 2026-07-22, so `send_gated`
is now `false`; their drafts instead carry `requires: "recorded PR-scoped maintainer consent before
foreign-runner run"`. The remaining requirement is per-PR maintainer consent (§4), not the boundary.
The `post_merge` draft is attached automatically to each dossier entry, personalized from the PR's own
facts. Render the always-safe ones directly, for example:

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

# Advance an offer as reality changes (never edit prior lines; always append):
node factory/offer-dossier.mjs advance --offer-id OF-owner/name-123 --stage offer_sent
```

Valid stages, in order: `identified`, `offer_drafted`, `offer_sent`, `yes`, `run_delivered`,
`five_questions_recorded`, `second_invocation`, `declined`, `no_response`. After any delivered run,
record the five demand questions in the operator record and advance to `five_questions_recorded`:
did it change what you inspected; did it save a rerun; did it speed a decision; would you invoke again;
what blocks automatic use. The metric that matters is **second voluntary invocation**, not compliments.

## 4. Foreign-PR verification — the consent-first procedure (now GO, still strict)

Use this only after §3 produced an offer, the maintainer consented to a specific PR, and you have read
`northset-oss/docs/foreign-run-gate-evidence-2026-07-22.md`. The GO is per-PR and conditional.

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

- `northset-oss/missions/M-004` is the V-lane rehearsal sample, state `prepared` and unpublished. It
  proves the consent to receipt path end to end. Re-run with `node bin/rehearse-v-lane.mjs` if you need
  to regenerate it. Publishing it is a separate founder decision; leave it prepared until then.
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
- Do not send `post_merge` or `rejection_harvest` without recorded PR-scoped consent.
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

1. Start Stream A (`run`) and let convertibility-aimed selection and harvesting operate normally.
2. Re-run `dossier` so the 11 identified offers gain their personalized `draft_message`.
3. Send the ungated offers today: `self_verify` in the most engaged open PR threads, and `issue_choice`
   with warm maintainers. Log each with `identify`, advance with `advance`.
4. For the strongest warm relationships, send `post_merge` offers under the §4 consent-first procedure.
   Only after PR-scoped consent, run `foreign-runner.mjs run`, deliver privately, record the five
   questions.
5. Report the week by the §6 scoreboard. Watch for second voluntary invocations; that is the signal
   that Level 1 demand is real.
```
