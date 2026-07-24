# Incident record: nodejs/doc-kit#901 closure — stress-tested diagnosis and decision review

Date: 2026-07-23
Status: RECORD OF REVIEW OUTCOME. Nothing below has been implemented. No public state, ledger
content, factory state, or GitHub content has been changed. All items are recommendations
pending owner decisions.
Update (later 2026-07-23): the owner decided to post one personally-written comment on the
closed PR (comments remain open). The finalized draft is recorded at the end of this document;
posting is done by the owner personally, not by tooling.

## What happened

nodejs/doc-kit#901 (mission M-012, campaign-v3 era) was approved on technical merits by both
maintainers (avivkeller 2026-07-19, AugustinMauroy 2026-07-21), then closed by avivkeller on
2026-07-23 19:02 UTC with review 4767280794: the project was "used as part of Northset's product
demonstration efforts" without consent; he asked that unconsenting projects not be used in
"promotional campaigns" and invited future contributions "in a personal capacity." The final head
was green, mergeable, and unchallenged technically.

## Review battery run (per operating practice: stress-test before concluding)

Three independent, read-only reviews over two frozen artifacts (team incident diagnosis +
candidate decision set D1–D9):

1. Adversarial red-team of the diagnosis (Claude, ~13 verified checks).
2. Adversarial red-team of the decision set (Claude, ~13 verified checks incl. live pages,
   offer funnel, factory DB).
3. Cross-vendor second opinion (Codex, independent live verification).

Raw inputs were frozen at /tmp/northset-incident/{diagnosis.md,decisions.md} (ephemeral); full
review reports live in the 2026-07-23 session task outputs.

## Verdicts on the team diagnosis (converged)

| Claim | Verdict |
| --- | --- |
| Timeline (approvals, body edit, review→close→edit, mergeable head) | CONFIRMED — every spot-check exact; closure-review edit was cosmetic |
| PR verification-pilot#51 added the conversion surfaces post-approval | CONFIRMED — site/repo/nodejs--doc-kit/index.html is status-added (347 lines) in the #51 diff; "Upstream CI agreed", "Maintain nodejs/doc-kit?", "All Northset work" are added lines |
| "#51 was the strongest identifiable trigger" | OVERCLAIMED (both reviewers) — no evidence the maintainer saw any ledger page; closing review names none; automation suspicion predates #51 by 5 days (hidden LLM canary, Jul 18); the complaint is fully explained by the PR-body disclosure alone; ≥4 rival hypotheses fit equally |
| CI-agreement claim improperly bound | CONFIRMED AND WORSE — receipt's "CI state: SUCCESS" observed Jul 19 21:55:58 UTC, before required workflows started (Jul 21 23:35; only Cursor Bugbot had run). Repo page renders "1 of 1 conclusive runs" stripped of qualifiers. Qualifiers mitigate, do not cure |
| "Internally permissible under Maintainer Respect Policy" | PARTIALLY REFUTED — the published M-012 surface breaches the policy's own self-run conditions: project-state claims (PR state / review signal), promotional content ("Maintain nodejs/doc-kit?"), more than one link, and an external upstream-verification claim bundled with consent_artifact: null |
| "Disclosure ≠ consent"; no landed Node AI rule violated | CONFIRMED |
| Risk analysis complete | REFUTED — three material omissions (below) |

### Material omissions (all three reviews)

1. GitHub AUP exposure: §10 (advertising on Pages), §4 (unsolicited solicitation / bulk
   automated activity), §7 (prefilled mailto solicitation) plausibly cover the repo-targeted
   CTAs. The realistic account-ending path is a spam/AUP report to GitHub, not maintainer
   discretion. Account survival is constraint #1 and this was absent from the diagnosis.
2. The maintainer's explicit "personal capacity" invitation is under-weighted; issue #897 is
   still open; "the PR cannot be rescued" is not established — only this PR as a
   Northset-branded submission is dead.
3. No forward-contagion model: the closing review is public, permanent, and citable by any
   future maintainer; current zero-spread is a snapshot, not a forecast.

## Consensus decision recommendations (converged across all three reviews)

- D1: Global pause on NEW upstream PRs, plus explicit wind-down of the ~35 open PRs
  (continue threads to natural completion; do not ghost mid-review maintainers). Doc-kit-only
  scoping misreads a program-level objection.
- D2: Remove repo-targeted CTAs and solicitation pages for ALL repositories (templated across
  ~30+ pages), executed as visible dated tombstones/corrections with hashes retained — never
  silent edits. Full consent-first re-architecture (anonymized/digest-only receipts) is a
  deliberate later strategy decision, but honor withdrawal-on-request immediately.
- D3: Remove the "Upstream CI agreed" rendering entirely (unanimous; strongest verdict).
  Even perfectly-bound "agreement" imports endorsement CI cannot give. If upstream status is
  shown: neutral fact only, never before workflows conclude.
- D4: Correct M-012's false "PR state OPEN" and stale review link via an explicit dated
  correction record preserving the prior rendered state by hash. Silent fix = the scrubbing
  accusation.
- D5: GitHub silence; no email; no site-wide incident statement. The only public note is the
  per-receipt correction record. Broadcast would manufacture the blast radius that currently
  does not exist (verified: zero third-party public mentions).
- D6: Never fake "personal capacity." De-branding while the pipeline still authors PRs is
  concealment and worsens the transparency problem. Honest equilibrium: first-person
  responsibility + accurate program naming + zero promotion (no CTA/stats/funnel). Drop
  "reviewed by Northset" (overstates). Open sub-choice: CTA-free single-mission link vs no
  link at all.
- D7: Branch prefix change is low priority and has quiet-de-brand optics; the real defect is
  Vercel preview deploys minting branded public URLs on upstream PRs — disable fork-PR
  previews or de-brand the Vercel project. (One divergence: Codex would drop the prefix now.)
- D8: Hold all 16 drafted Level-1 offers (none were ever sent — verified). DELETE Move 6
  ("harvest rejecting maintainers as verification prospects") outright. Encode a hard
  never-contact block for nodejs/doc-kit and avivkeller. On any future resume: a maintainer
  inviting more contributions has consented to patches, not to a verification pitch.
- D9: Adopt message-side flags (hidden HTML comments / canaries / consent-marketing language;
  human-review only; never auto-respond to or game a canary) AND add the more important
  output-side publish-time invariant gate: block publication of any page rendering a stale PR
  state, endorsement language, not-yet-existing external status, or a repo-targeted CTA
  without a consent artifact.

## Newly discovered during review (absent from the original diagnosis and decision set)

1. northset-oss/verification-pilot issue #1: standing public solicitation issue (open since
   Jul 10; targets "especially AI-assisted" PRs; links a Payment Policy; routes to
   oss@northset.ai). Must be in D2's scope.
2. Metrica-Academy/northset-verified-intake: private third-party repo ("northset verified
   issue handoff packets"). OPEN QUESTION for owner: operator-owned (benign) or a real
   external engagement (falsifies D8's zero-relationships premise)?
3. The stop is not encoded: active factory DB has no repository_state row for nodejs/doc-kit
   and no prospect entry — nothing mechanically prevents a new doc-kit PR or a Move-6 fire.
4. Sequencing: (1) pause + offer hold + encode never-contact blocks → (2) neutralize the
   templated promotional layer globally (CI-claim, all CTAs, issue #1) + M-012 correction,
   all via tombstones → (3) then decide the ~35 open PRs' existing footers → (4) last, the
   deliberate consent-first re-architecture.

## The meta-decision (explicitly deferred to owner)

All three reviews independently concluded that D1–D9 remediate surfaces, while the
maintainer's objection was to the model: unsolicited AI PRs at volume, converted into a
demand-generation funnel for a paid verification product. Whether #901 was "a bug in our
promotion" or "a signal that the unsolicited-volume-to-conversion model is itself the
liability" is the decision that determines recurrence. The trigger evidence cannot settle it
(the maintainer may never have seen any ledger page). Owner decision pending.

## Open questions blocking completion

1. Ownership/nature of Metrica-Academy/northset-verified-intake (owner answer required).
2. Whether the meta-decision goes through the same adversarial battery before being decided.

## Owner question (2026-07-23): "Is this a call to shut down the pilot? What's left to prove?" — Claude owner assessment

### No — it's not a shutdown call. It's a separation call.

The recommendations kill one specific thing: **the acquisition channel** — repo-targeted CTAs,
the "CI agreed" credibility borrowing, the post-merge offer playbook, Move 6, the solicitation
issue, the velocity-as-strategy. What they leave standing is everything Northset actually set
out to prove. The pilot conflated three layers, and the reviews only condemn one of them:

**Layer 1 — the product hypothesis (untouched).** "Maintainers drowning in review burden will
request — and eventually pay for — signed, isolated, reproducible verification runs." Every
piece of machinery behind that survives: the boundary suite, the isolated runner, the receipt
format, consent artifacts, private delivery, the `northset-verify` intake. Level 1 is
consent-native by definition — a maintainer asking is the product working. Nothing in D1–D9
restricts a run that someone asked for.

**Layer 2 — the credibility layer (survives, in honest form).** Contributing, disclosing, and
attaching a neutral receipt to one's own work all remain. The 27 merges and the warm
relationships remain real assets. What's removed is only their *conversion*: using other
people's repos and review labor as exhibits in a funnel.

**Layer 3 — the growth mechanism (dead, and correctly so).** This is what the maintainer
called the marketing stunt, and the reviews concluded he described it accurately.

### What's left to prove — the only question that was ever worth the pilot

Under the old design, the pilot couldn't have proven its thesis even if it succeeded. If a
maintainer said "yes" to a verification run 48 hours after a merged fix, at "peak goodwill,"
prompted by an individualized offer — is that product demand, or reciprocity pressure
manufactured by the funnel? Indistinguishable. The evidence was contaminated at the source;
the maintainer found the contamination before the metrics did.

Implementing the recommendations converts the pilot from manufacturing demand evidence to
measuring it:

- **The clean experiment:** affordance visible where consenting people already look (own site,
  org README, the label), plus honest contributions at sane cadence. Then count: does anyone
  ask? Every inbound "yes" is uncontaminated evidence. Silence for three months is also a
  valid result — the old design was structurally incapable of producing that result, which is
  what made it a campaign rather than a pilot.
- **Demand signals that survive scrutiny:** inbound requests; spontaneous in-thread asks; and
  the "de facto delegation" observation (Move 8) — maintainers merging PRs while visibly
  relying on the receipt instead of re-running CI. Pure passive measurement, no contact,
  arguably the strongest demand signal available. No recommendation touches it.
- **The integrity fixes ARE the product.** D3, D4, and the publish-time invariant gate are not
  concessions extracted by an angry maintainer. A verification company whose core artifact
  rendered "Upstream CI agreed" from a status observed before the workflows ran, and displayed
  "PR state OPEN" on a closed PR, had a correctness bug in the one thing it sells — trustworthy
  claims. Fixing that under a visible correction policy is proving the thesis in public.

### Honest cost accounting

- The L0→L1 plan's timeline is gone; consent-paced demand arrives when it arrives.
- The pilot can now fail: it might prove nobody asks. That risk is the price of the answer
  meaning something.
- The closing review, read as market data: it confirmed the pain (heavy review labor — the
  exact burden the product claims to relieve) while rejecting the channel. "Your product may
  have a market; you may not acquire customers through the review queues of unconsenting
  volunteers" is channel feedback, not a shutdown verdict. Front-door channels (OpenJS,
  GitHub's maintainer-tooling push, CI vendors, maintainer communities) may validate the
  thesis faster than the cold channel ever could.

The meta-decision is therefore not "shut down vs. continue" but: does Northset believe its
thesis enough to let it be tested without the funnel? If the thesis is true, it survives
consent. If it only works without consent, it was never a product.

## Public comment on PR #901 — finalized draft (2026-07-23)

Owner decision: post one personally-written comment on the closed PR. Draft went through
three iterations plus an adversarial red-team pass. The red-team rejected v2 for: (1) claiming
removal that had not yet happened — a catchable false statement; (2) spotlighting ledger
defects (false CI claim, stale state) the maintainer may never have seen; (3) overpromising
org-wide policy change; (4) prose polish reading as LLM-generated to an audience that planted
an LLM canary; (5) internal jargon ("receipts") linking the apology back to the ledger.

### HARD PRECONDITION before posting

The sentence "I've taken nodejs/doc-kit off the pilot's pages" must be TRUE at the moment of
posting. Execute the doc-kit removal/redaction on the public ledger (repo page, CTA, receipt
entry or its repo-identifying content) FIRST, then post. If posting must happen before
removal is complete, change that sentence to "I'm removing nodejs/doc-kit from the pilot's
pages" — never claim completed action that has not completed.

### Final draft (v3)

> You're right, and I'm sorry.
>
> I disclosed the pilot in the PR body, but I never asked whether you wanted your project
> involved in it. Disclosure isn't consent. That was on me. You and Augustin put real time
> into reviewing this, and I attached your project's name to a pilot you never agreed to be
> part of. I understand why that's not okay.
>
> I've taken nodejs/doc-kit off the pilot's pages, and it won't be used that way again.
>
> I'm not resubmitting this change. If any of it is useful to whoever picks up #897, it's
> free to use, nothing owed.
>
> If I contribute here again, it will be a personal contribution, with no pilot attached.
> Thank you for being direct about this, and for leaving that door open.

### Posting guidance

- Posted personally by the owner, under his own account, ideally with his own small wording
  adjustments so it is genuinely in his voice.
- No links, no @-mention of AugustinMauroy (do not notify him into a controversy he did not
  start; the un-tagged "Augustin" reference is deliberate).
- One comment only. No follow-up if there is no reply; no follow-up argument if the reply is
  cold. The comment discharges the obligation either way.
- #897 verified as the correct underlying issue (still open; PR body said "Fixes #897").
