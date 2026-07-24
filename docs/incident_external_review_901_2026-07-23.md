# Executive verdict

This incident does **not** justify shutting down Northset’s OSS work, rebuilding the orchestrator, or abandoning proof-of-pass receipts.

It does require an immediate separation of three activities that the current system has coupled together:

1. **Ordinary OSS contribution:** Northset prepares a useful patch, a named person reviews it, and that person submits it under the repository’s normal rules.
2. **Verification product:** Northset runs checks for a maintainer who explicitly requested or installed the service.
3. **Marketing and demand generation:** Northset describes its product, publishes case studies, and seeks customers through Northset-controlled channels.

The incident occurred because activity 1 was converted into activities 2 and 3 **without separate consent**. The public ledger then compounded the problem by attaching mutable upstream CI and review facts to an immutable receipt for different patch bytes.

My recommendation is therefore:

> **Pause new upstream PR publication and all outreach for a short, implementation-bounded remediation window; continue local preparation and support for existing PRs; remove the acquisition layer; correct the public record; then resume ordinary contributions in a promotion-free lane. Build Northset Verify only through explicit installation or maintainer request.**

This should be a surgical remediation, not another months-long architecture project. Keep the core factory. Delete the funnel.

---

# 1. Independent incident assessment

## 1.1 What is established

PR #901 was not closed for an unresolved technical defect. The final head implemented the simplification requested by the maintainer. Aviv Keller approved that head on July 19, 2026, and Augustin Mauroy approved it on July 21. On July 23, Aviv changed his review and closed the PR because of the surrounding Northset program, the use of volunteer review work in a product demonstration, and the absence of consent for promotional use. The final review expressly separated that objection from the code’s technical merits. ([GitHub][1])

The submission was not covert. Its PR body disclosed AI assistance, linked Northset’s ledger, acknowledged that the original M-012 receipt no longer covered the revised head, and took personal responsibility for the checks on the current revision. ([GitHub][1])

The maintainer’s automation concern also existed before the July 21 ledger redesign. On July 19, he asked for a simpler implementation and said he preferred to speak with a human; Aysajan replied that he was reading and typing the comments personally. This makes it impossible to establish that ledger PR #51 was the single cause of the closure. ([GitHub][1])

Nevertheless, PR #51 materially worsened Northset’s position. Its own commit description says it added repository-templated maintainer boxes, a public request CTA ahead of email, CI “agreement” statistics, and generated per-repository pages. It merged only after the final code head had already received its two technical approvals. ([GitHub][2])

The public state is objectively defective:

* `missions/M-012/publication.json` still records the PR as open, with `head_drift: true`, `ci_state: success`, and a stale decision URL.
* The generated repository page says “Upstream CI agreed with the receipt,” while simultaneously explaining that the current PR head was not executed by that receipt. It also asks “Maintain nodejs/doc-kit?” and presents public-request, prefilled-email, and sample-receipt conversion links.
* The live receipt still shows the PR as open, reports CI success, warns that the PR changed from the recorded patch, and ends with a product request box. ([Northset OSS][3])

There is also evidence of a deployment-parity problem. The live page displays an older July 15 observation and intermediate head, while the repository’s current `publication.json` contains a July 19 observation and final head. Both are stale relative to the July 23 closure, but they are stale in different ways. That means correcting the source file alone is insufficient; Northset must verify what Pages actually serves.

Finally, the problem remains active in the current orchestrator. The uploaded system contains:

* a `verification_prospects` table populated from AI-policy and “not wanted” rejections;
* automatic `post_merge` offer drafting;
* an ungated `rejection_harvest` message;
* an always-available receipt-page affordance;
* language such as “checkable in ~30 seconds without trusting us” and “reviewed by Northset.”

That establishes that this is not only an old renderer defect. The acquisition logic is encoded in the active factory.

## 1.2 What is not established

The evidence does **not** establish that:

* Aviv saw the repository page or M-012 receipt before closing the PR.
* PR #51 was the decisive trigger.
* Node.js or doc-kit had a landed policy categorically banning AI-assisted contributions.
* Every Northset-authored contribution is unwelcome.
* GitHub has determined that Northset violated its policies.

The current doc-kit contribution guide covers normal workflow, testing, changesets, formatting, conventional commits, and DCO. I found no explicit landed AI-assistance or commercial-affiliation prohibition in it. That does not reduce the maintainer’s authority to close a contribution or ask that his project not be used promotionally.

## 1.3 The actual root causes

### A. Consent-scope collapse

Northset treated several different permissions as interchangeable:

* invitation to contribute to an issue;
* permission to publish a technical run record;
* permission to monitor and render mutable project outcomes;
* permission to use the project name, CI, and maintainer review as product evidence;
* permission to approach the maintainer with a verification offer.

They are not interchangeable.

A `good first issue` label supports an ordinary contribution. It does not authorize a repository-specific Northset acquisition page, a case study, a product CTA, or a claim that upstream CI agreed with Northset’s evidence.

Northset’s own Maintainer Respect Policy already says an authored receipt should make no claim about project state, contain at most one plain link, include no promotional content, and be removed from public surfaces on request. The current M-012 surface violates those promises.

### B. Acquisition-channel contamination

The system converted:

* merges into “warm relationships”;
* closed or AI-rejected PRs into verification prospects;
* repository queues into candidate PRs for offers;
* technical receipt pages into lead-generation pages.

That is the core strategic defect. “The maintainer rejected our patches, so offer another product” is almost the inverse of respecting a stop signal.

### C. Claim-integrity failure

“Upstream CI agreed” is not merely poor marketing language. It is an invalid verification claim when:

* CI ran against a different head;
* the receipt itself reports head drift;
* required checks were not all terminal when the status was captured;
* CI is being described as agreement or endorsement rather than as a neutral external observation.

Even with perfect head binding, CI cannot “agree” with Northset. It can only report statuses for a named commit.

### D. Maintainer-attention cost

The initial implementation needed multiple rounds of substantial technical correction. One maintainer eventually asked why the implementation was so complex and requested a much simpler form. That is relevant even though the final code was technically acceptable: Northset’s product goal cannot justify externalizing experimentation and model iteration onto volunteer reviewers. ([GitHub][1])

### E. GitHub account exposure

The dominant platform risk is no longer API throughput. GitHub’s current Acceptable Use Policies prohibit automated excessive bulk activity, bulk promotional distribution, unsolicited advertising or solicitation, using GitHub information for unsolicited email, and advertising in other users’ accounts. GitHub may suspend or terminate accounts or remove content in response to violations. GitHub also separately prohibits significant or continual disruption of other users, including excessive notifications. ([GitHub Docs][4])

GitHub Pages is intended primarily to showcase projects and is not intended as free hosting for an online business or commercial SaaS. GitHub expressly recommends contacting Support when the intended use may fall into those categories. A plain technical transparency ledger is much more defensible than a ledger containing repo-specific sales funnels and product-intake forms. ([GitHub Docs][5])

This does not mean GitHub has found a violation. It means the current architecture creates unnecessary, account-level exposure—the exact failure Northset has said it cannot tolerate.

---

# 2. Adjudication of D1–D9

## D1 — Global pause on new upstream PRs; wind down existing inventory

**Verdict: Agree, with a narrower duration and clearer scope.**

Immediately pause:

* new upstream PR creation;
* new public receipt publication;
* every outbound verification offer;
* all automated lead or dossier generation intended for contact.

Do **not** pause:

* local discovery;
* local candidate analysis;
* authoring and isolated verification;
* private artifact production;
* replies and fixes on already-open PRs;
* genuinely maintainer-requested verification delivered privately.

Do not mass-close the existing open PR inventory. That would abandon maintainers who have already invested attention and could create a new wave of notifications. Continue each existing conversation to its natural outcome, answer maintainer questions promptly, and withdraw immediately where requested.

For doc-kit specifically:

* keep PR #901 closed;
* do not reopen it;
* do not resubmit the same patch from another account or under quiet debranding;
* permanently block `nodejs/doc-kit` from Northset-authored submissions unless the maintainers explicitly invite Northset back;
* place a temporary owner-level hold on new `nodejs/*` submissions while the incident is remediated and reviewed.

The “future contributions in personal capacity” sentence should not be used as a loophole. It permits genuine future personal participation in the normal workflow; it does not authorize Northset to resubmit the same pipeline-produced work while hiding the program.

The global pause should end when the concrete resume checklist in §6 passes—not after an arbitrary social waiting period.

## D2 — Remove repository CTAs and promotional pages globally

**Verdict: Strongly agree; modify the tombstone design.**

Remove globally:

* “Maintain `<repository>`?” boxes;
* “All Northset work in `<repository>`” pages;
* public request CTAs from authored receipt pages;
* prefilled maintainer email links;
* `northset-verify` label instructions on authored receipt pages;
* product samples attached to authored contribution pages;
* repository-specific solicitation and conversion copy;
* the standing issue #1 intake surface while the model is revised.

Issue #1 is currently an open, standing request that specifically targets maintainers with AI-assisted PRs, routes them to Northset, and links the Payment Policy. It should be closed or archived during remediation.

I disagree with leaving a permanent branded tombstone at every repository page. That would continue the unwanted association. Use this approach instead:

1. Preserve the prior bytes and their hashes in Git history and a corrections ledger.
2. Remove repository pages from site navigation and search.
3. Return a neutral `410 Gone` or minimal no-index page for old repository routes.
4. Keep one direct M-012 correction page because Northset must correct the factual record.
5. Unlist M-012 from promotional/homepage displays.
6. Retain the immutable release artifact for provenance.

Move product marketing, intake forms, pricing, and email conversion to `northset.ai` or another Northset-controlled commercial host. The GitHub repository and Pages site should be a sparse technical project and provenance surface.

## D3 — Remove “Upstream CI agreed”

**Verdict: Unqualified agreement. Remove the entire concept.**

Do not attempt to repair the phrase by adding more head checks. Delete:

* `ci_agreement`;
* agreement counts;
* “agreed” and “disagreed” language;
* repository-level agreement statistics;
* discrepancy marketing based on “Northset versus upstream”;
* any implication that CI validated, endorsed, confirmed, or ratified a receipt.

The minimum safe immediate implementation is to show **no mutable CI or review status on immutable receipt pages**. Link to the upstream PR for current state.

A later neutral status display is acceptable only when it records:

```json
{
  "observed_head_oid": "<exact 40-hex>",
  "status": "success",
  "required_checks_total": 12,
  "required_checks_terminal": 12,
  "observed_at": "<timestamp>",
  "source": "<upstream PR or commit URL>"
}
```

and only if:

* the observed head equals the tested receipt head;
* every required check is terminal;
* the status is labeled unattested external metadata;
* wording is strictly factual, for example:
  **“GitHub reported 12 required checks successful for commit `abc123…` at `<time>`.”**

No form of “agreement” should return.

## D4 — Correct M-012 with a dated record

**Verdict: Strongly agree. This is the first public-state fix.**

Leave the immutable M-012 bundle unchanged. Correct the mutable publication envelope to contain:

* `state: "closed_unmerged"`;
* the final PR head OID;
* the final closure review URL;
* the actual closure time;
* `ci_state` omitted from the receipt interpretation or represented only as exact-head external metadata;
* an explicit correction object;
* the prior rendered-page hash;
* the replacement-page hash;
* a correction timestamp and reason.

Recommended correction text:

> **Correction — July 23, 2026**
> PR #901 was closed unmerged after a maintainer objected to Northset’s use of the project and its review process in a product demonstration. M-012 remains only an immutable record of the original `a0bdd2d…` patch and the single listed command. Earlier rendered status showing the PR as open, and language describing upstream CI as agreeing with M-012, were inaccurate and have been withdrawn. The later PR head was not executed by M-012.

The direct page should contain only:

* this correction;
* the exact immutable technical scope;
* the artifact digest and verification command;
* no CTA;
* no repository statistics;
* no product offer;
* no generalized claims about maintainers or Node.js.

Then run a global reconciliation audit over every receipt for:

* stale PR state;
* stale review decision;
* missing closure state;
* head drift;
* “agreement” language;
* receipt/head mismatches;
* public CTAs;
* generated repository pages.

Also add a deployment-parity assertion. A deployment should fail unless the served site identifies and matches the expected source commit and generated artifact digest. The present difference between repository state and live Pages output shows this is load-bearing.

## D5 — No public reply, email, or incident broadcast

**Verdict: Agree under the owner’s no-reply decision.**

Do not:

* argue technical merits;
* cite the absence of a formal AI rule;
* explain the product thesis;
* ask the maintainer to reconsider;
* email him privately;
* turn the incident into a public debate;
* publish a site-wide defensive essay.

Silence is acceptable only if the offending surfaces are removed quickly. Leaving the pages live while remaining silent would communicate the opposite of respect.

The dated M-012 correction is sufficient public accountability. It corrects Northset’s own claims without escalating the interpersonal dispute.

Were the owner ever to change the no-reply decision, the maximum appropriate reply would be:

> Understood, and I’m sorry. I have stopped Northset submissions to doc-kit and am removing the promotional surfaces. I will not resubmit this change.

Nothing more.

## D6 — Do not fake “personal capacity”; resolve the link question

**Verdict: Agree with the principle; resolve the open sub-choice as “no public receipt link by default.”**

Quietly changing the branch name while continuing the same funnel would be concealment. Conversely, an ordinary personal-responsibility contribution need not include a product brochure.

For the resumed authored lane, use the repository’s required AI disclosure. In the absence of a repository-specific format, use:

> AI assistance was used through tooling operated by Northset. I reviewed the final diff and test results and take personal responsibility for this contribution.

Then list the exact checks inline.

Do not include by default:

* a Northset receipt URL;
* a mission number;
* Northset product copy;
* “reviewed by Northset”;
* “checkable without trusting us”;
* a CTA;
* a ledger root link;
* aggregate campaign statistics.

The internal receipt should still be produced and retained for every mission. It becomes public only under an explicit, separate publication rule.

A public link may be included only where one of these is true:

1. the repository policy explicitly permits or asks for this evidence;
2. a maintainer requests the receipt in the PR;
3. a maintainer provides specific public-receipt consent.

Even then, the link goes to one technical receipt page with no product funnel.

This is not debranding or concealment. The AI and Northset tooling are disclosed, while the contribution remains an ordinary contribution rather than a product demonstration.

## D7 — Branch prefix and Vercel preview

**Verdict: Partly disagree with the team’s prioritization.**

The Vercel preview shown on PR #901 appears to be created by the upstream OpenJS Vercel integration, not by Northset’s public ledger. Northset should not attempt to modify or disable another project’s deployment integration.

For new branches, adopt normal descriptive names such as:

```text
fix/config-discovery
fix/non-positive-transfer
test/replication-precheck
```

rather than `northset/M-012`.

This is a small etiquette improvement, not the primary remediation. Do not rename existing live branches merely for optics, and do not imply that the Vercel preview caused the incident.

The actual controlled surfaces are:

* Northset’s PR body;
* Northset’s receipt link;
* Northset’s Pages content;
* Northset’s funnel and outreach system.

Fix those first.

## D8 — Cancel offers and delete rejection harvesting

**Verdict: Strongly agree, and expand beyond Move 6.**

Delete `rejection_harvest` entirely. A maintainer declining patches or expressing an AI concern must result in:

```text
DO_NOT_AUTHOR
DO_NOT_CONTACT
```

not:

```text
VERIFICATION_PROSPECT
```

Also remove from the automated production path:

* `post_merge`;
* auto-generated offer drafts;
* the `issue_choice` funnel;
* `self_verify` as a product pitch;
* passive receipt-page affordances;
* warm-relationship lead generation;
* automatic mining of another repository’s stuck PR queue;
* offer-funnel stage tracking for unsolicited outreach.

A human contributor may naturally ask an already-engaged maintainer what issue would be useful next. That ordinary human interaction does not need a message generator, prospect database, conversion stage, or campaign metric.

Treat every existing offer draft as:

```text
CANCELLED_POLICY
```

Do not rely solely on the team’s statement that none were sent. Audit the JSONL funnel, local DB, email sent folders, GitHub comments, and any task outputs before closing the incident.

Replace `verification_prospects` with a minimal interaction-block record:

```json
{
  "scope": "repository | owner | user",
  "subject": "nodejs/doc-kit",
  "block_authoring": true,
  "block_outreach": true,
  "reason": "explicit maintainer stop",
  "source_url": "...",
  "created_at": "...",
  "release": "manual_only"
}
```

Immediate records:

* repository: `nodejs/doc-kit`;
* owner/org: `nodejs` for the temporary authored hold;
* user/contact: `avivkeller`;
* all with outreach blocked;
* no automatic expiry.

A merge, approval, constructive review, or issue invitation must never automatically become consent to a commercial offer.

## D9 — Message-side canaries and publish-time invariant gate

**Verdict: Agree, but prioritize output-side controls.**

Message-side handling:

* treat HTML comments, hidden Unicode, bidirectional text, and LLM-oriented instructions as untrusted data;
* surface them for human review;
* never automatically comply with them;
* never “solve,” answer, or game a maintainer’s canary;
* do not classify an issue as hostile merely because it contains one.

The more important remediation is a pure, deterministic publish validator. It should reject any authored receipt or page containing:

* `mailto:`;
* public run-request links;
* `northset-verify` instructions;
* “maintain `<repo>`?”;
* repository-targeted CTA text;
* “agreed,” “validated,” “endorsed,” or equivalent external-approval language;
* mutable PR state older than its freshness limit;
* CI/review state for an OID different from the tested OID;
* public verification artifacts without publication consent;
* repository-level pages without marketing/publicity consent;
* named project statistics being used as product evidence;
* unresolved source/deployment digest mismatch.

M-012 should become the permanent regression fixture for this gate.

---

# 3. Additional remediations the team should add

## 3.1 Represent four distinct permissions

Do not retain one generic `consent_artifact`. Store separate scopes:

```text
contribution_invitation
verification_execution_consent
receipt_publication_consent
marketing_reference_consent
```

Rules:

* An issue label can satisfy `contribution_invitation`.
* It satisfies none of the other three.
* A request to run checks may satisfy `verification_execution_consent`.
* It does not permit public publication.
* Permission to publish a receipt does not permit a case study, repository page, outreach, testimonial, or aggregate marketing.
* No scope may be inferred from a merge, approval, silence, CI success, or positive review.

This is the conceptual repair that prevents recurrence.

## 3.2 Delete invalid demand signals

Remove or stop using:

* “de facto delegation” inferred because a maintainer did not rerun CI;
* merges as product-demand events;
* approvals as sales leads;
* rejections as verification prospects;
* absence of maintainer objection as consent;
* public CI as evidence that maintainers relied on Northset.

Valid product demand is:

* a maintainer installs the GitHub App;
* a maintainer explicitly requests a run;
* a maintainer invokes a second run;
* an organization agrees to a pilot;
* an organization pays or renews.

Nothing else should be presented as demand.

## 3.3 Make the verification product consent-native

Successful high-volume OSS automation products operate after repository-owner action:

* CodeRabbit requires installation and repository authorization before it reviews PRs.
* Renovate is installed on selected repositories and does not open further update PRs until its onboarding PR is merged; closing that PR opts the repository out.
* Dependabot version updates are enabled through repository-owned configuration. ([CodeRabbit][6])

Northset Verify should adopt the same pattern:

```text
maintainer installs or explicitly requests
-> Northset verifies
-> private result by default
-> optional public receipt by separate consent
```

There should be no cold conversion path from Northset-authored PRs.

## 3.4 Separate recognition from repository queues

Northset can still build recognition through:

* an aggregate, anonymized campaign report;
* open-sourcing the verifier and receipt format;
* reproducibility challenges on Northset-owned repositories;
* opt-in case studies;
* invited talks and maintainer panels;
* public benchmark datasets without named-project promotion unless authorized;
* GitHub App adoption;
* independent technical research.

Recognition should be earned on Northset-controlled surfaces, not embedded in volunteer review queues.

## 3.5 Introduce legacy-receipt classification

M-012 and any other early receipt lacking the current commit/tree binding should not appear equivalent to modern receipts.

Label them:

```text
LEGACY_SELF_RUN_RECORD
patch-bytes bound
patch-commit not execution-bound
not suitable for external-status correlation
```

Do not include legacy records in aggregate “receipt strength” statistics without separate denominators.

## 3.6 Resolve the Metrica repository without blocking emergency work

Until ownership and initiation are established, classify `Metrica-Academy/northset-verified-intake` as:

```text
INTERNAL_OR_UNVERIFIED_RELATIONSHIP
```

It must not count as independent inbound demand unless Northset can show that:

* the repository is controlled by an external organization;
* the request originated independently from that organization;
* an authorized representative requested the verification;
* the relationship was not created or prompted by Northset for the pilot.

This question affects demand accounting, not the emergency pause or renderer correction.

## 3.7 Contact GitHub Support

Submit the support inquiry before a material volume restart. Describe:

* AI-assisted, human-reviewed authored contributions;
* the one-account policy;
* final human approval;
* one-open-PR-per-repository control;
* the removal of repo-targeted marketing and unsolicited outreach;
* intended public PR rates;
* the technical transparency ledger;
* private-by-default opt-in verification;
* the proposed GitHub App installation model.

Ask specifically whether:

1. the proposed authored-contribution rate creates AUP concerns;
2. a CTA-free technical receipt ledger is appropriate for GitHub Pages;
3. product intake should live outside GitHub Pages;
4. a GitHub App installation is the preferred consent boundary.

A support response is not a safe harbor, but ignoring this ambiguity would be imprudent.

---

# 4. Minimal code change set

Do **not** redesign the authoring, verifier, board, approval, publication checkpoint, or GitHub safety queue. Those are not the incident’s root cause.

## Active orchestrator

### `factory/cli.mjs`

* Remove `dossier` from normal production commands.
* Reject execution of offer-generation or offer-advance commands while policy version 2 is active.
* Add one simple global publication pause checked by `publish`.
* Do not stop local workers when the policy pause is active.

### `factory/offer-messages.mjs`

* Remove from the active runtime or move to `archive/incident-2026-07-23/`.
* At minimum, make every message unavailable and fail closed.
* Delete `rejection_harvest`.
* Do not leave a CLI that an agent can accidentally invoke.

### `factory/offer-dossier.mjs`

* Archive it.
* Stop scanning warm repositories for contributor PRs.
* Stop drafting messages.
* Preserve existing JSONL files as incident evidence.

### `factory/db.mjs`

* Migrate `verification_prospects` into `interaction_blocks`.
* Add repository, owner, and user scopes.
* Support independent `block_authoring` and `block_outreach`.
* Require manual release for explicit maintainer stops.
* Seed the nodejs/doc-kit and avivkeller records.

### `factory/reconciler.mjs`

* A negative AI/process/not-wanted signal creates a block.
* It never creates a prospect.
* Remove `proto_signals` or any inference that no maintainer rerun means reliance.
* Keep ordinary factual outcome reconciliation.

### `factory/discovery.mjs` and candidate selection

* Exclude author-blocked repositories and owners before model work.
* Record the exact block reason.
* Do not treat blocked repositories as possible product prospects.

### `factory/worker.mjs`

Replace the current footer with a promotion-free disclosure.

Default:

```md
AI assistance was used through tooling operated by Northset. I reviewed the final diff and test results and take personal responsibility for this contribution.

Checks:
- `<exact command>` — passed
```

No public receipt URL by default.

### `factory/board.mjs`

Display:

```text
receipt_visibility: private_internal | public_opt_in
publication_consent: absent | present
marketing_consent: absent | present
```

For the authored lane, default to `private_internal`.

### `factory/publisher.mjs`

Before any outbound action:

* enforce all interaction blocks;
* require the new promotion-free PR body;
* prohibit public receipt links without publication consent;
* prohibit repository pages without marketing consent;
* ensure an explicit maintainer stop cannot be bypassed by the repository-cap override.

### Root `AGENTS.md`

Add binding operational rules:

* Never generate or send conversion outreach.
* A rejection or AI-volume concern creates a stop, not a prospect.
* Never infer consent from merge, approval, CI, silence, or issue labels.
* Never publish a named receipt without the appropriate consent scope.
* Never represent CI or review as agreement or endorsement.
* Never debrand Northset-generated work to simulate personal capacity.
* Continue supporting existing PRs; do not use them for product conversion.

## Public ledger

### `lib/ledger.mjs`

Delete:

* repository-page generation;
* CI agreement aggregation;
* CTA rendering;
* maintainer email generation;
* product conversion blocks.

### Publication projection

* Keep immutable technical evidence separate.
* Update mutable status only as a neutral, source-linked record.
* Add explicit correction records.
* Never synthesize endorsement.

### M-012

* Correct `publication.json`.
* Add the dated correction.
* Unlist from normal index views.
* remove the nodejs/doc-kit repository page.
* retain the immutable release.

### Issue templates and intake

* Remove or disable `request-a-run.yml` during remediation.
* Close issue #1.
* Move future product intake to Northset’s own domain or GitHub App installation.

### CI tests

Add fixtures covering:

1. head drift plus successful CI;
2. nonterminal required workflows;
3. stale open state after closure;
4. CTA on authored receipt;
5. repository page without publicity consent;
6. public receipt without publication consent;
7. deployment/source mismatch;
8. every forbidden endorsement synonym;
9. M-012’s exact historical failure.

---

# 5. Immediate 48-hour execution plan

## T+0 to 2 hours

1. Set the global policy publication pause.
2. Disable every offer/dossier command.
3. Mark every existing draft `CANCELLED_POLICY`.
4. Persist:

   * `nodejs/doc-kit` authoring and outreach block;
   * temporary `nodejs` owner authoring block;
   * `avivkeller` contact block.
5. Stop generating new public-ready PR bodies using the old footer.
6. Keep local authoring/verifying workers running if desired.
7. Continue responding to existing maintainers and CI failures.
8. Do not post or email anything about #901.

## T+2 to 8 hours

1. Remove CI-agreement rendering globally.
2. Remove every CTA, prefilled email, product box, and repository page.
3. Correct M-012.
4. Close or disable issue #1 and the request template.
5. Regenerate the site.
6. Deploy.
7. Fetch the live site independently and verify:

   * correction present;
   * stale OPEN state absent;
   * no “agreed” language;
   * no CTA;
   * no repository page;
   * deployment commit/digest matches the expected source.

## T+8 to 24 hours

1. Remove the active offer funnel from `factory/`.
2. Migrate `verification_prospects` to interaction blocks.
3. Change the worker footer and public-receipt default.
4. Add consent-scope fields.
5. Add publish-time invariant tests.
6. Audit every existing public receipt.
7. Audit every open Northset PR for:

   * linked stale receipts;
   * mismatched heads;
   * promotional language;
   * current maintainer objections.
8. Do not mass-edit upstream PR bodies. Neutralize their link targets centrally; update an upstream body only when needed naturally or requested.

## T+24 to 48 hours

1. Run the full orchestrator and ledger test suites.
2. Run a fake/rehearsal publication.
3. Confirm crash recovery and existing PR reconciliation remain intact.
4. Submit the GitHub Support inquiry.
5. Review the complete existing-open-PR inventory.
6. Have the owner explicitly clear the global publication pause.
7. Resume the contribution-only lane under the rates below.

---

# 6. Resume gate

New upstream PR publication resumes only when all are true:

```text
[ ] All automated outreach and offer drafting disabled
[ ] rejection_harvest deleted from active runtime
[ ] interaction blocks persisted and enforced
[ ] nodejs/doc-kit and avivkeller blocks tested
[ ] M-012 correction live
[ ] M-012 removed from normal promotional/index views
[ ] repository-targeted pages removed or neutralized
[ ] no “CI agreed” or equivalent language anywhere
[ ] no authored receipt page contains a CTA or mailto solicitation
[ ] live Pages commit/digest matches expected source
[ ] PR body contains no public receipt link by default
[ ] public receipt publication requires explicit publication consent
[ ] marketing reference requires separate marketing consent
[ ] open PR inventory reviewed
[ ] all M-012 regression tests pass
[ ] GitHub Support inquiry submitted
[ ] owner explicitly clears publication pause
```

---

# 7. How the OSS mission should resume

## 7.1 Local proof factory: full speed

The local system may continue 24/7:

```text
discover
-> preflight
-> author
-> verify
-> private internal receipt
-> READY
```

No artificial human-shift limits are needed. The final public action remains batch-approved.

This preserves the engineering experiment and lets Northset produce large numbers of verified artifacts without burdening maintainers.

## 7.2 Public authored lane: contribution-only mode

For the first 20 post-incident PRs:

* maximum 3 new PRs per day;
* maximum 1 per hour;
* distinct repository owners where possible;
* one open PR per repository;
* no more than 2 new PRs to one owner in a rolling seven days;
* Green work only;
* no dependency, CI, public API, security, migration, broad design, or generated-output changes;
* preferably maintainer-authored issue with exact expected behavior;
* no claim comment unless the repository explicitly requires one;
* no Northset product link;
* no post-merge offer;
* no issue-choice pitch;
* no public named receipt without consent.

After 20 completed or meaningfully reviewed PRs with:

* zero process/promotion objections;
* no missed maintainer replies;
* no platform warning;
* no owner-level concentration problem;

increase to 5 per day.

Do not exceed 10 new authored PRs per day until:

* GitHub Support has responded;
* an aged cohort shows the interaction is sustainable;
* the team can service every existing conversation promptly;
* no additional consent or promotional objection appears.

This rate is much lower than the former 100/day plan. That is not a loss of technical throughput; it is a separation of **local verification throughput** from **public maintainer burden**.

## 7.3 Verification lane: demand-paced, not campaign-paced

The verification lane can scale faster only where maintainers explicitly opt in.

Acceptable triggers:

* GitHub App installation;
* approved repository configuration;
* explicit maintainer request;
* maintainer-applied label under a previously approved policy.

Execution remains private by default. Public receipt publication is a later, separate approval.

No outbound cold or warm conversion is needed. This is the CodeRabbit/Renovate pattern: owners install or onboard the automation, then it acts.

## 7.4 Recognition lane

Northset should publish:

* aggregate conversion and failure rates;
* anonymous failure taxonomies;
* verification reproducibility results;
* costs and latency;
* verifier source code;
* opt-in named case studies;
* criticism and corrections;
* clearly separated authored, requested-verification, private, and public counts.

Do not publish a repository-specific success page merely because a PR was merged.

---

# 8. What this means for the 1,000-receipt goal

The old formulation—1,000 public, repository-named receipts attached to 1,000 Northset-initiated PRs in a short campaign—is no longer compatible with the stated requirement that GitHub account survival is paramount.

The experiment should use typed counters:

```text
LOCAL_VERIFIED_INTERNAL
AUTHORED_PR_SUBMITTED
AUTHORED_PR_MERGED
VERIFY_MAINTAINER_REQUESTED_PRIVATE
VERIFY_MAINTAINER_REQUESTED_PUBLIC
PUBLIC_RECEIPT_OPT_IN
```

Northset can still reach 1,000 `LOCAL_VERIFIED_INTERNAL` artifacts quickly.

It should not call those 1,000 instances market demand.

Demand is demonstrated by:

* installed repositories;
* maintainer-authorized runs;
* second voluntary invocations;
* organizations returning without a Northset prompt;
* paid pilots and renewals.

The authored PR lane remains valuable for:

* proving the authoring and verification machinery;
* improving OSS projects;
* learning which task classes work;
* building technical credibility.

It must no longer serve as the customer-acquisition funnel.

---

# Final recommendation

Approve the team’s overall **separation** conclusion, with these substantive modifications:

1. Treat PR #51 as a serious aggravating event, not a proven singular trigger.
2. Pause new public PRs only until the defined remediation gate passes; do not shut down local work.
3. Do not mass-close existing PRs.
4. Remove repository pages, CTAs, prefilled email, and CI-agreement language globally.
5. Correct and unlist M-012 while preserving its immutable artifact.
6. Delete the complete automated offer funnel, not only rejection harvesting.
7. Replace prospects with hard authoring/outreach blocks.
8. Make authored receipts private by default and public only by explicit publication consent.
9. Separate contribution, execution, publication, and marketing consent.
10. Resume ordinary contributions at 3/day for the first 20, then increase cautiously.
11. Scale Northset Verify only through installation or explicit maintainer request.
12. Preserve the 1,000-artifact engineering goal, but stop equating public receipt count with product demand.

The fastest safe course is not another redesign. It is to **keep the factory, delete the funnel, correct the claims, and restart the contribution lane as an ordinary contributor.**

[1]: https://github.com/nodejs/doc-kit/pull/901 "feat(config): auto-detect supported config files in the working directory by AysajanE · Pull Request #901 · nodejs/doc-kit · GitHub"
[2]: https://github.com/northset-oss/verification-pilot/pull/51 "Redesign receipt disclosure and harden factory publication by AysajanE · Pull Request #51 · northset-oss/verification-pilot · GitHub"
[3]: https://northset-oss.github.io/verification-pilot/receipts/M-012/ "M-012 Proof-of-Pass Receipt"
[4]: https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies?apiVersion=2022-11-28 "GitHub Acceptable Use Policies - GitHub Docs"
[5]: https://docs.github.com/en/enterprise-cloud%40latest/pages/getting-started-with-github-pages/github-pages-limits?utm_source=chatgpt.com "GitHub Pages limits - GitHub Enterprise Cloud Docs"
[6]: https://docs.coderabbit.ai/platforms/github-com?utm_source=chatgpt.com "CodeRabbit Documentation - AI code reviews on pull requests, IDE, and CLI"
