# OSS Orchestrator — HANDOFF (start here next session)

**Status:** Design v0 written + Round-1 dual-vendor critique DONE → verdict **DO-NOT-SHIP v0**.
Next: rewrite DESIGN → v1 around the fixes below, re-critique (Round 2), build, Round 3 on code.
Founder chose to do the v1 rewrite + build in a FRESH session. Nothing is lost — read this file.

---

## 0. What this is
A private orchestrator (`/Users/aeziz-local/oss-orchestrator/`, git, never pushed public) that will
run Northset's OSS contribute-first loop AUTOMATICALLY and IN PARALLEL (3→5→cautious-10 at a time):
per candidate — same-day recheck → owner freezes spec → Codex implements in an isolated clone →
containerized red→green verify → signed `author_contribution` receipt (northset-oss pipeline) →
owner reviews diff → founder authorizes → push receipt+attest + open PR from AysajanE → typed
ledger row. Today this is done by hand, one at a time (see §2). The orchestrator automates the
machine steps and keeps the two human gates.

**Non-negotiable:** no mission reaches an outbound action (PR open / northset-oss push+attest)
without (a) owner diff-review AND (b) founder authorization of THAT EXACT diff+PR-text. Volume never
buys down review — if production outruns review, THROTTLE PRODUCTION.

## 1. Founder decisions (LOCKED — 2026-07-12)
1. **Delete merged forks — but MANUALLY in v1.** Auto-delete DEFERRED to v2 (both vendors: highest
   irreversible risk = can silently close a live PR; least value = forks are free). v1 monitoring
   script FLAGS "safe to delete"; owner/founder deletes by hand. v2 auto-delete needs fork
   ref-counting + the shared push-lock, only after 3-way concurrency proves crash/dup-scheduler safe.
2. **Ramp 3→5→cautious-10**, adversarial-review layer as the quality lever. "Proven" at each step =
   ZERO quality escapes + smooth resource use + adv layer catching things before owner review.
3. **Monitoring flag-only to start** (no auto-outbound; align to existing 07:30/18:00 ET Telegram cron).
4. **Founder is the authorization ceiling at EVERY N** (no gate buy-down — every outbound PR
   founder-reviewed line-by-line).
5. **Codex quota headroom for 3–5 concurrent xhigh — confirmed OK.** Executor stays Codex.
6. **Build process:** design-first, then ≥3 cross-vendor rounds (Round 1 = design [DONE],
   Rounds 2–3 = code), both vendors in parallel each round, owner self-assessment REDACTED from
   critique handoffs, any vendor disagreement escalated to founder.

## 2. Current live state (as of 2026-07-12)
- **Shipped this session (both live, awaiting maintainers — MONITOR THESE):**
  - M-008 `blockly-samples#2510` → PR https://github.com/RaspberryPiFoundation/blockly-samples/pull/2748
    (head db5ccc9; receipt attested; ledger A-002; CLA/CI held behind first-time-contributor gate; coverage confirmed).
  - M-009 `prettier#19588` → PR https://github.com/prettier/prettier/pull/19611
    (head 296019b; receipt attested; ledger A-003; CLA-free; changelog #19611 matches PR#).
  - Prior: M-007 `jeo-maven-plugin#1538` → PR #1573 (ledger A-001).
- **northset-oss** (public verification-pilot) main tip after M-009 attested = `8673fd5`; ledger has
  7 rows; live at https://northset-oss.github.io/verification-pilot/. Next receipt = **M-010**.
- **Register:** `docs/internal/.../phase0_ignition/13_live_oss_target_candidate_register_2026-07-11.md`
  (100 candidates; done 1–3 = jeo#1538, blockly#2510, prettier#19588). Candidate 4 storybook#31800
  is NOT clean (possibly already fixed + stale claims) — skip/verify. Candidate 5 = clap#3360 (Rust).
- **Ledger (internal):** `docs/internal/.../phase0_ignition/11_pull_events_ledger.md` (A-001..A-003).
- **gh** authed as AysajanE; token LACKS `delete_repo` scope (needed for v2 auto-delete) and `user`
  scope (email list). Identity for OSS commits = `aeziz@northset.ai` (verified on AysajanE), per-clone
  never global. Docker 29.5.3; node 22; codex-cli 0.144.1.

## 3. Pieces the orchestrator drives (verified real)
- `~/.claude/model-delegation/codex_implement.sh` — Codex impl (workspace-write, no-commit delegate
  header, ≤2 resume rounds, one worktree per run; **persists RAW logs — secret-scrub needed**).
- `~/.claude/model-delegation/codex_critique.sh <repo_root> <prompt> <out> [model] [effort] [web]` —
  read-only critique (gpt-5.6-sol xhigh default). Used for the vendor critiques.
- `/Users/aeziz-local/northset-oss/` — `bin/run-mission.mjs` (pipeline), `lib/pipeline.mjs`
  (code-binding is SOUND; **rollback only restores mission dir, not index/site — non-atomic**),
  `lib/executor.mjs` (2-phase Docker; phaseA:bridge/phaseB:none; sandbox is SOLID),
  `lib/ledger.mjs` (build/render — **whole-tree readdir rebuild = the C3 contamination root**),
  `bin/verify-receipt-parity.mjs`, `bin/bundle.mjs verify`, `.github/workflows/attest-bundle.yml`
  (push to main touching `missions/**/bundle/**`, HEAD~1 diff, **fails closed on >1 mission**).
- Per-mission worked examples: `/Users/aeziz-local/oss-missions/M-008-blockly-2510/` and
  `M-009-prettier-19588/` (input JSON, executor-base, fix.patch, verify.sh — templates for the harness).

## 4. Round-1 critique outcome (both vendors CONVERGED → DO-NOT-SHIP v0)
Full critiques: `round1_critique_codex.md`, `round1_critique_claude.md`. Design under review:
`DESIGN.md` (v0). Convergence across two vendors (independent) = high confidence these are real.
Highest-risk (both): **approvals check a checkbox, not the exact code** → a normal push-time rebase
ships UNREVIEWED code to a real maintainer while both gates report OK (fires on the happy path).

## 5. DESIGN v1 — the fix list the rewrite MUST implement (adjudicated from both critiques)
**CRITICAL (structural):**
1. **Content-bound approvals.** Record `reviewed_patch_diff_hash` + `authorized_patch_diff_hash`
   (+ base + head + EXACT rendered PR title/body + receipt digest) at the two human gates. Push
   asserts all equal what's about to go out. ANY rebase/edit/regen invalidates both → re-review +
   re-auth. **NEVER rebase at push — push the exact bound commit.** (kills C1)
2. **Per-mission disposable checkouts + clean-main-add-one at push.** Receipts built in isolated
   clones. At push: fresh clean checkout of the verified remote tip → add EXACTLY one authorized
   mission → rebuild index/site THERE → assert full commit diff + ledger closure. (kills C3 leak +
   multi-mission attest fail + pipeline non-atomicity)
3. **No auto-fork-delete in v1** (founder decision #1). (kills C2 for v1)

**HIGH:**
4. **Singleton scheduler + fencing epochs; ALL northset-oss/board mutation (incl. both crons)
   through one lock.** (H1)
5. **Enforced review-WIP ceiling** — hard cap + age limit on unreviewed/unauthorized missions that
   BLOCKS new spec/code admission. THIS is the throttle, mechanized. (H2)
6. **Durable operation journal** for the ~8-step ship path (intent + observed result per irreversible
   op; deterministic branch/tag identities; ambiguous result → STOP for owner, never blind-rerun);
   model attest-fail + `workflow_dispatch` re-trigger by mission_id. (Codex#5, H4)
7. **Immutable mission-id once published; no double-attest** (reconcile existing digest, never
   regenerate/clobber a different one). Define mutable-post-attest fields (maintainer_outcome) OUT
   of the attested/parity bundle; outcome updates never re-attest. (Codex#10, H3)
8. **Secret-free clones + minimal env + scrub/restrict Codex raw logs.** (Codex#12, L2)

**MEDIUM:**
9. **Dual-vendor adversarial on EVERY mission** (blast radius selects, not complexity); each finding
   explicitly dispositioned before owner-approve; skeptics run from a FRESH allowlisted bundle
   (diff+spec+verify only), no board access, clean each round. (M1, M2, Codex#14, L3)
10. **Recheck before ANY outbound + gate PR-open on head==tested BEFORE open** (reorder). (M3, INV-3)
11. **`--require-success` unconditional** on this path (no optional weakening). (Codex#13)
12. **Clarify red-first = out-of-band owner verification, NOT a receipt gate** (receipt attests the
    green run only; executor can't capture red). (M5)
13. **Candidate uniqueness enforced at insert; INV-3 counts OUR OWN same-account PR as skip.** (M4)
    **+ Recheck MUST scan the issue-timeline cross-references for prior CLOSED competing PRs, not
    just an open-PR text search.** REAL 2026-07-12 miss (A-003): prettier#19588 had an identical
    prior PR #19589 (paranoa233, "Fixes #19588") closed the day before; our open-PR-only check read
    "0 prior PRs" (wrong) and we contributed a duplicate that core maintainer @fisker silently
    closed in 30 min. A silently-closed identical external fix = strong SKIP-or-ASK signal
    (maintainer likely owns/reworks the issue). The thorough timeline check (used for blockly#2510)
    must be applied to EVERY candidate, including clean-looking ones (0 comments ≠ no history).
14. **Base-SHA freshness TTL** — bind + check target base before auth/open; base moved → back to
    verify (+ owner review if material). (Codex#15)
15. **Track detached Codex subprocess/session for resume** (no double-spawn). (M8)

**Scope for v1 (start-at-3):** pin C=3, D=1–2; NO auto-fork-delete; NO C=10 auto-formula; batched
founder gate is FINE once #2 (isolated checkouts) lands. Defer non-core surface until the cardinal
path (content-bound approval + isolated ship transaction + WIP throttle) is proven under 3-way
concurrency with crash/restart/dup-scheduler tests.

## 6. Plan for the fresh session
1. Rewrite `DESIGN.md` → v1 implementing §5. Keep §5 items traceable (tag each with which finding).
2. **Round 2** = cross-vendor re-critique of DESIGN v1 (both vendors, redacted) — structural changes
   deserve a design re-check before code.
3. Build: owner OWNS the safety-critical/tripwire spine (content-bound approvals, ship transaction,
   locks, journal) — this is tripwire-flagged, brain must own end-to-end; Codex may implement
   well-fenced mechanical pieces under a frozen contract with owner review of every line.
4. **Round 3** = cross-vendor critique of the CODE (frozen diff); fix; re-attack if needed (≥3 total).
5. Integrate, run concurrency/crash/dup-scheduler tests, present to founder before any live run.
6. Separately: `pr-status-sync` (flag-only) + `fork-cleanup` (flag-only v1) per §5.

## 7. Do NOT
- Do not run the orchestrator live until v1 is built, code-reviewed (Rounds 2–3), and concurrency-
  tested. Continue any interim missions by HAND (the proven M-008/M-009 flow).
- Do not auto-delete forks in v1. Do not push >1 mission per northset-oss push. Do not let any
  path reach outbound without content-bound owner-review + founder-auth.
