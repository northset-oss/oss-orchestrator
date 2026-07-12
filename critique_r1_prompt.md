MODE: adversarial DESIGN critique — findings only, do NOT redesign or write code.

CONTEXT. Read `DESIGN.md` in this directory (the repo root). It specifies an orchestrator that will
drive Northset's OSS contribution loop: run Codex to fix real GitHub issues, build signed receipts,
and OPEN PULL REQUESTS TO REAL OSS REPOS at 3→5→10 parallelism. This is critical, hard-to-reverse
infrastructure. A bug can: spray bad or duplicate PRs to real maintainers (a named spam/AUP
kill-bar that can ban the founder's identity), leak secrets, corrupt shared state, double-attest,
or — the cardinal sin — let an UNREVIEWED change go outbound. Stated non-negotiable: every Codex
diff owner-reviewed, every PR founder-authorized, quality NEVER traded for volume.

For grounding, also read (read-only) the real pieces it orchestrates:
- `~/.claude/model-delegation/codex_implement.sh` — how Codex is invoked; worktree + quota rules.
- `/Users/aeziz-local/northset-oss/lib/pipeline.mjs` and `lib/executor.mjs` — receipt build; the
  SHARED `missions/index.json` + `site/index.html`; the one-mission-per-push attest constraint.
- `/Users/aeziz-local/northset-oss/.github/workflows/attest-bundle.yml` — the attest trigger
  (push to main touching `missions/**/bundle/**`, fails closed on >1 mission).

YOUR JOB: attack the DESIGN. Find where it FAILS. Rank findings by severity (CRITICAL / HIGH /
MEDIUM / LOW). Hunt specifically for:

1. INV-1 breach — ANY path in the §3 state machine that reaches an outbound action (PR open, or
   northset-oss push/attest) WITHOUT both owner-review AND founder-authorization in history.
   This is the cardinal sin; try hard to find an interleaving/resume/error path that skips it.
2. Concurrency: races on board.json (single-writer claim — is it really?), the northset-oss lock,
   worktrees, receipt/push serialization. Can two missions push at once? Corrupt index.json?
   Double-attest? Can the scheduler and a resumed run both act on one mission?
3. Idempotency / resume: name a stage where a crash-then-resume double-acts (double PR, double
   push, double fork, double ledger row) or corrupts committed state.
4. Irreversible-op safety: can any bug/interleaving delete a fork that still has an open PR (which
   silently CLOSES that PR), open the same PR twice, or push an unintended mission?
5. TOCTOU: the final-recheck→PR-open gap (INV-3); the head==tested timing (INV-2); the fork-delete
   "zero open PRs" check vs. a concurrently-opened PR.
6. Is the adversarial-review layer (§6) real quality or theater? Does the redaction of the owner's
   self-assessment actually happen given the owner writes the board the skeptic reads? Could the
   skeptics collude via shared context / a shared prompt blind spot?
7. Quality-at-scale: where does quality SILENTLY degrade as N goes 3→10? Is "throttle production,
   don't rush review" actually ENFORCEABLE in this design, or just aspirational prose? What
   concrete mechanism throttles production when review falls behind?
8. Over-engineering: what is premature for a start-at-3 v1 and should be cut or deferred?
9. Failure modes NOT modeled: partial push, attest fails after the receipt commit lands, PR opens
   but the ledger write fails, fork push succeeds but PR-create fails, board write fails mid-transition.

Be concrete: name the stage/invariant and the exact interleaving, input, or error that triggers
the failure. Do NOT rewrite the design — identify defects, severity, and the MINIMAL fix
direction. If a whole component is wrong, say so and why. End with the single highest-risk defect.
