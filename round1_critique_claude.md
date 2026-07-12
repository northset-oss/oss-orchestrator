# Round 1 — Claude adversary critique of DESIGN.md v0 (2026-07-12)

Independent Claude-side adversarial review, grounded against the real code (pipeline.mjs,
executor.mjs, ledger.mjs, bundle.mjs, mission-validator.mjs, attest-bundle.yml, codex_implement.sh).
Reviewer deliberately did NOT read the Codex critique prompt, to avoid anchoring.

## Verdict: DO-NOT-SHIP (as specified) — not for a real-PR run at any N, including N=1.

## CRITICAL

**C1 — Approvals check stage-PRESENCE, not binding to the reviewed/authorized diff. Unreviewed
code can go outbound (fires on the HAPPY path).** stage_history records `{stage,at}`; the record
has head_commit/patch_diff_hash but no `reviewed_patch_hash`/`authorized_patch_hash`; the founder
authorizes a mission_id, not a diff digest. INV-2's `pr_head==head_commit==patch_commit` is
self-consistency among three artifacts the push stage itself produces. Failure (no error path
needed): mission authorized for head H1 (founder saw diff D1); the `fork→push branch` step
normally rebuilds the branch from a fresh fork clone at current upstream → head H2, diff D2
(rebase absorbs upstream drift/conflict resolution); orchestrator sets head_commit=H2; the
self-consistent H2 trio satisfies INV-2; INV-1 sees reviewed+authorized in history → **D2, never
reviewed/authorized, opens as a PR to a real maintainer.** Also reachable via resume-after-partial-
push, a manual worktree nit-fix, or the INV-2-abort→re-code loop (target state left unspecified).
FIX: record reviewed_patch_diff_hash + authorized_patch_diff_hash at the two human gates; INV-1
asserts both equal artifacts.patch_diff_hash (+base+head) at push; any regen/rebase/edit
invalidates both → re-review + re-auth. **Single most important change.**

**C2 — Fork is a SHARED per-repo resource; cron fork-cleanup's "zero open PRs" is a racy
point-in-time check outside any lock → can delete a fork with a live PR, silently closing a
maintainer's in-review PR.** Two missions targeting prettier share one fork. cleanup marks
delete-eligible per-mission and isn't under the northset-oss lock. Failure: M1 merges → fork
eligible; at that instant M2 has push-branched but not yet opened its PR (or PR-count read is
momentarily stale — eventual consistency); cleanup sees 0 PRs, deletes the fork → **closes M2's
PR on upstream irreversibly.** The AUP/relationship kill-bar. FIX: ref-count fork lifecycle across
all missions sharing it; delete under the same lock the push holds + re-check under it. "Dry-run,
proven once" does NOT close the race.

**C3 — Receipt stage mutates the SHARED PUBLIC index.json + site/index.html and drops the mission
dir into the northset-oss tree BEFORE founder authorization → a held/unauthorized mission leaks
outbound on the next authorized push.** runPipeline (receipt, precedes the gate) calls buildLedger
which readdirs EVERY mission dir and rebuilds public index.json + site (whole-tree, not
per-mission). So a receipted-then-HELD mission A sits uncommitted; when B is receipted (index now
lists A+B), authorized, pushed: `git add -A` → 2 missions → attest fails closed (bricks B); precise
`git add` → committed index/site still list A (private candidate name published publicly).
FIX: build receipts in an isolated clone; at push, in a CLEAN checkout of main, add only the one
authorized mission, rebuild index/site THERE, commit, push. Kills leak + multi-mission attest fail.

## HIGH

**H1 — "Single-writer scheduler" is an assumption, not a mechanism; the design's own crons write
shared state outside the receipt/push lock.** flock+temp-rename makes individual writes atomic;
it does NOT enforce one scheduler process or make a read-modify-write transaction atomic. Two
schedulers (operator + cron/resumed) both read M at specced → double Codex run + lost-update board
clobber. pr-status-sync (cron) is a SECOND writer to the northset-oss tree (updates
maintainer_outcome / index rebuild) racing the push. FIX: process-lifetime singleton scheduler
lock; route ALL northset-oss/board mutation (both crons included) through it; per-mission fencing.

**H2 — No mechanism couples review-queue depth to production admission; "throttle production, don't
rush review" is aspirational prose.** spec (top) and owner-review (middle) are decoupled serial
stages → owner keeps speccing while diffs pile in adv_reviewed. No "don't admit new mission while
adv_reviewed depth ≥ K" rule. FIX: explicit backpressure gate on unreviewed/unauthorized WIP that
blocks new spec/code admission.

**H3 — Receipt is built + attested BEFORE patch_commit/attestation_uri/outcome exist; populating
them later mutates the bundled, attested, parity-checked mission.json.** patch_commit is
required-40-hex schema but the executor git-applies uncommitted (only exists after fork commit);
attestation_uri only exists post-attest; the bundle CONTAINS mission.json + maintainer_outcome.json.
So INV-2's receipt.patch_commit is null at attest time (binding vacuous) OR the orchestrator
rewrites mission.json post-attest (invalidating the attested digest/parity). §7's
"update maintainer_outcome on merge" mutates a field baked as `pending` into the immutable attested
bundle → parity breaks, or re-bundle → old attestation no longer verifies. Maintainer outcome is
INHERENTLY post-attestation, unmodeled. FIX: define exactly which fields are mutable-post-attest,
keep them OUT of the attested/parity bundle, outcome updates never re-attest.

**H4 — attest-fails-after-receipt-commit-lands is unmodeled.** The receipt commit is already public
+ immutable on main; attest is async (minutes); if it fails (Sigstore/Rekor outage, or C3 multi-
mission guard), there's no rollback and re-run needs a new bundle push or manual workflow_dispatch
(unmodeled) → resume polls forever; wedged mission + public unattested receipt. FIX: model attest
failure explicitly (workflow_dispatch re-trigger by mission_id); treat unattested public receipt
as alarmed.

## MEDIUM
- **M1** Cross-vendor critique gated on code COMPLEXITY (xhigh), but EVERY outbound PR is max blast
  radius (founder tripwire) → dual-vendor for EVERY mission, blast radius not diff-complexity selects.
- **M2** Adv findings are non-blocking notes; nothing forces disposition → rubber-stamp under
  pressure. FIX: explicit per-finding disposition (fixed/won't-fix-because) before `reviewed`.
- **M3** INV-2 verified AFTER PR open → untested head can reach maintainer before the check fires.
  Gate PR-open on head==tested BEFORE open.
- **M4** Candidate-uniqueness asserted but not enforced; INV-3's "no-competing-PR" may not count OUR
  OWN PR → double PR to same issue (spam signal). FIX: enforce uniqueness at insert; INV-3 treats an
  existing same-account PR as terminal-skip.
- **M5** "red-first" is NOT mechanized by the executor (one pass; can't un-apply patch;
  requireSuccess rejects failing commands) → red→green as a receipt-backed gate isn't supported; it
  is a second out-of-band owner run. Clarify: receipt attests the GREEN run; red-first is
  owner-verification, out of band.
- **M6** Founder authorizes "that specific PR" but the board carries no pr_title/pr_body → Codex-
  drafted external copy (tripwire class) can go outbound without exact-wording review. FIX:
  authorization artifact includes the exact rendered PR title+body.
- **M7** northset-oss lock held minutes across async attest; stale-lock/liveness unspecified; ship
  path is serial → C=10 grows produce-side WIP, not ship throughput (the H2 inventory problem).
- **M8** Resume doesn't reconcile in-flight DETACHED Codex subprocesses → re-spawn double run,
  orphan worktree, racy session id.

## LOW / cut-for-v1
- **L1** Cut fork auto-delete entirely for v1 (highest irreversible risk, least value — delete by
  hand). Cut the C=10 ramp + auto D-formula (unvalidated) — pin C=3, D=1–2. [Also floated per-PR
  interactive auth vs batched — but batched is safe ONCE C3 is fixed with isolated checkouts.]
- **L2** INV-10 doesn't cover the gh/git credential surface (token in a remote URL).
- **L3** Adv re-review anchoring: on a second adv pass, rebuild the skeptic handoff clean each round
  (don't leak round-1 findings / owner's prior rejection).

## Consensus-caution note (Claude reviewing a likely-Claude design)
The correlated blind spot hunted for and FOUND: over-trust in "asserted in code" (§5) as if
assertion == binding, plus a single-tidy-event-loop mental model that under-weights distributed
reality (two crons, resume, GH-Actions async, multi-process). Every CRITICAL + top HIGH live in
that seam. A second same-lineage reviewer should re-check THAT zone independently, not the
invariant list (which reads clean and is the easy thing to nod at). [NOTE: Codex — a different
vendor — INDEPENDENTLY found the same CRITICALs, which strongly confirms them.]

## Checked and found NO problem with
- Executor sandbox is solid (cap-drop=ALL, no-new-privileges, non-root, read-only rootfs,
  phase-B --network=none, git-hardening, symlink-safe tree digests, patch hashed-once).
- Code-binding (pipeline.mjs) genuinely prevents a receipt naming code it didn't run (bidirectional
  patch binding; dirty-tree → null source_commit). Provenance logic is sound; H3 is timing/mutability.
- attest workflow's own multi-mission fail-closed + mission-id sanitization are correct/fail-safe —
  the problem is FEEDING it contaminated pushes (C3), not the workflow.

**Single highest-risk defect: C1** — nothing binds the pushed diff to the exact patch the owner
reviewed and the founder authorized, so an ordinary push-time branch rebuild ships unreviewed,
unauthorized code to a real maintainer while both gates report satisfied. Fires on the happy path.
