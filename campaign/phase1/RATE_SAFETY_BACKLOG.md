# GitHub rate-safety — post-resume backlog

Status: the rate-safety program (gateway, AIMD budget, archive miner, controls CLI,
protocol amendment A1) is implemented and committed. Resume is authorized on a
**risk-scoped bar** (founder decision, 2026-07-18): resume is blocked only by findings that
(1) risk a GitHub account ban, (2) cause an unrecoverable brick with no operator lever, or
(3) allow an unsafe unauthorized outbound action. All such findings across multiple
cross-vendor (Codex + Claude) adversarial passes were resolved before resume.

The GitHub-account-safety core (single gateway spawn site, concurrency 1, pacing floors,
pagination rejection, terminal GitHub-throttle latching with no auto-retry, founder-only
clearance, entry-point hold gating) passed three independent cross-vendor passes.

The items below are **consciously deferred** — each is fail-closed, founder-recoverable, and
does not risk the GitHub account. They are tracked to be burned down while the mission runs,
and re-reviewed before the Phase 2 ramp (which raises daily volume and account exposure).

## Deferred items

1. **Live-provider validation of the model-throttle path (R1/R2).** The trusted-structured
   model-provider throttle signal (`trusted_model_provider_error`, populated only from typed
   Codex `--json` transport metadata) was verified offline only. Confirm against a real Codex
   provider 429 the first time one is encountered; adjust the allowlisted provider codes if the
   live envelope differs. Scope: model/OpenAI subscription breaker, not GitHub.

2. **Single global gateway lock — design characteristics.** All GitHub traffic serializes
   through one machine-wide lock (this is the safety mechanism). Accepted consequences:
   (a) no priority between classes, so bulk discovery can queue ahead of publication follow-up;
   (b) an unclean holder crash imposes up to the bounded stale-lock window before reclaim.
   Revisit only if measured contention hurts follow-up SLA at ramp; a priority lane for
   publication/maintainer-response traffic is the likely fix.

3. **AIMD history gaps across skipped UTC days.** Multiple idle days collapse into a single
   rollover step and one history entry (conservative by design). Fix only if the history is
   later consumed as a contiguous per-day series.

4. **Env-knob trust model.** `OSS_GH_CANONICAL_ROOT` and the budget-override decision-id gate
   are consistency/audit controls, not authorization boundaries — an operator who can set env
   vars can adjust them. Acceptable for a single-operator local runner; revisit if the runner
   is ever multi-tenant.

5. **Standing re-review cadence.** Adversarial review of the recovery machinery will always
   surface additional fail-closed edge cases; that is expected and is not a resume blocker.
   Schedule one consolidated cross-vendor pass before the Phase 2 ramp rather than gating the
   Phase 1 restart on zero findings.
