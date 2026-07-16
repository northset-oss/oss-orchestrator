# Archived OSS Mission Orchestrator target architecture (lean rebuild)

This design record is historical. `OPERATING_CONTRACT.md` is the active bounded workflow contract.

Status: FROZEN design for cross-vendor review, then Codex (gpt-5.6-sol, high) implementation.
Author: Claude (owner). Supersedes the scan/receipt-split `runner.mjs` and the manual M-008/M-009 ship.

## 0. The atom — the only thing we are here to produce

> **An AI-authored patch, applied to a named base commit, made the project's own declared check
> pass inside a network-isolated container — here is the signed, anyone-can-re-run record, and a PR.**

Receipt = `{ candidate, base_commit, patch, check_command, isolated_run_output, exit=0, bundle_digest, attestation_uri }`.
Everything in this system exists to produce that atom, fast, in parallel, and to put it in front of a
maintainer + on the public page. Anything else is deleted.

## 1. Principles

1. **Fuse author and verifier.** The thing that writes the fix can run the check. No blind coding.
2. **The receipt is exhaust, not a stage.** The isolated check run you do anyway *is* the record.
3. **One human gate.** The founder reviews once; the machine does everything before and after.
4. **One isolation boundary, chosen by need, not by fear.** (§3.)
5. **No binding ceremony for a solo trusted operator.** Cut TOCTOU/multi-party guards.
6. **Parallel by default.** Throughput = attested receipts/day, which we control — not merges, which we don't.

## 2. Runtime workflow — two commands, ONE authorization

```
oss prepare [--only IDs] [--concurrency N]        # everything up to "ready for your review"
   per candidate, in parallel:
     a. recheck  — one API call: still open, unassigned, no competing/duplicate PR? else SKIP.   (the one guard that pays)
     b. container(fix+verify+receipt) — §3/§4: produce a VERIFIED patch + the isolated run record.
     c. draft the exact PR title + body (technical + mandatory Northset receipt footer).
     d. write a self-contained "ready pack" for the mission and add it to ONE review board.
   → prints ONE board: every ready mission shows { diff, green check result, receipt digest, exact PR text }.

   --- THE SINGLE HUMAN GATE: founder reads the board once. ---

oss ship --approve ID[,ID...]                      # after approval, fully automatic, no further prompts
   per approved mission, atomically:
     e. fork (once) + push the reviewed commit to AysajanE:northset/<id>.
     f. publish the receipt to northset-oss, attest it (CI), verify the attestation, record the URL.
     g. open the PR (nodejs/... <- AysajanE:northset/<id>) with the drafted text; assert PR head == reviewed OID.
     h. append the public ledger row.
   → prints the PR URL + attestation URL per mission.
```

There is exactly **one** human decision: approve which prepared missions to ship. No PR-text gate, no
per-step confirmations, no double-recheck ritual. `prepare` produces only VERIFIED fixes, so the board
is high-signal; the founder reviews the diff + PR text together, once, and ships the batch.

## 3. Sandbox judgment (orchestrator's decision)

**Decision: ONE disposable Docker container per mission is the entire isolation boundary. Codex runs
INSIDE it.** The container holds: the repo @ base_commit, its deps, network (during fix only), and an
ephemeral, scoped Codex auth. It holds **nothing else from the host** — no gh token, no SSH keys, no
cloud creds, no host filesystem. Network is ON during fix/install, **OFF** for the final receipt run.
The container is destroyed after.

Rationale, measured against real threats for a solo operator contributing to reputable repos
(nodejs, prettier, prometheus, redis…):

- **Untrusted test code** (incl. a poisoned npm dep) runs in the container, never on the host. ✔
- **Prompt injection of the AI** is bounded: the AI is *in* the container with no host secrets to
  exfiltrate and no host to damage; its only durable output is a patch, which the founder reviews
  before ship. ✔
- **Reproducibility** (the receipt's whole value) requires a container anyway — so isolation is free.
- The old design ran TWO boundaries (a Codex sandbox with no deps/network + a separate Docker
  executor). That is what blinded the coder and caused the retry loop. **One boundary, shared by the
  coder and the verifier, is both simpler and safer for the host.**

Escalation rule (not a default): if a mission targets a low-reputation repo, add an egress allowlist
to the fix phase. Not built now; noted.

## 4. The container run (the core loop)

Per mission, inside one disposable container (recommended: a prebuilt `northset/mission-runner` base
image with Codex + common toolchains, so per-run setup is just the repo's own deps):

```
1. clone/copy repo @ base_commit; set commit identity LOCAL = Aysajan Eziz <aeziz@northset.ai>.
2. install deps (network ON).
3. codex exec (gpt-5.6-sol) with the issue + prompt AND the ability to run the declared check:
      loop { edit → run check_command → read result } until the check passes or effort budget hit.
   (this is the fix — the author sees the verifier; no separate blind scan.)
4. commit -s (DCO). Fail-closed: author==committer==aeziz@northset.ai + Signed-off-by, else FAIL.
5. network OFF. run check_command ONCE → capture stdout/stderr/exit. Require exit 0.
6. emit receipt bundle (patch, base, command, isolated output, digest) — the attestable record.
```

Steps 3+5 replace the old "blind scan → separate Docker receipt build." The check runs during fixing
(feedback) and once isolated (proof). Same command, no triple-run.

## 5. Receipt + public page (reuse the product, simplify the packaging)

- **Keep** the GitHub artifact **attestation** (`actions/attest-build-provenance`) and the public
  **ledger + page** (northset-oss/verification-pilot). These are the promise; they are not the pain.
- **Simplify** the local packaging: the receipt is the flat set of fields in §0 + the redacted run
  output. Drop the multi-file bundle ceremony, the local ledger/site rebuild during the run, and the
  parity apparatus **if** the cross-vendor review agrees they add no external value; otherwise keep the
  minimum the attestation subject requires. (Open question OQ-2.)
- **Automate** the northset-oss add+attest+PR sequence (what was done by hand this session) inside
  `oss ship`. One code path, not an 8-step manual dance.

## 6. Cut / keep, against the atom

KEEP (it *is* the atom or directly serves it): base+patch; the network-OFF check run; the attestation;
PR + receipt link; correct identity + DCO (mechanized); ONE recheck (duplicate guard); one disposable
container.

CUT: the Codex-sandbox-with-no-deps (merged into the container); the scan/receipt split; blind coding;
the separate receipt-build stage; `head==tested`/`patch_diff_hash`/double-recheck binding; multi-round
manual ship; the 2-commit northset-oss dance as a manual step; heavy spec/path-traversal validation
(keep a thin schema check only); per-step human confirmations.

## 7. Invariants that remain (few, load-bearing)

- **INV-CHECK-GREEN:** no receipt without an exit-0, network-OFF run of the declared check.
- **INV-IDENTITY:** every shipped commit is `aeziz@northset.ai` + DCO, verified fail-closed.
- **INV-FOOTER:** every PR body carries the Northset receipt-disclosure footer (single enforcement point).
- **INV-RECHECK-ONCE:** one duplicate/cleanliness recheck immediately before ship; a failed timeline
  fetch is fail-closed (the A-003 lesson — the one guard worth keeping).
- **INV-ONE-GATE:** nothing is pushed/attested/PR'd without exactly one founder approval of the batch.
- **INV-NO-HOST-SECRETS:** the mission container never receives host secrets beyond the scoped Codex auth.

Everything else the old system enforced is dropped as ceremony.

## 8. Acceptance criteria (how we know the build works)

1. `oss prepare --only <clean JS candidate>` produces, in one pass, a verified patch whose declared
   check passes network-OFF, plus a drafted PR body with the footer, and stops at a review board —
   with **no separate receipt step and no retry loop** on a fix that is right the first time.
2. A deliberately-broken fix (check fails) yields FAIL at prepare time (fail-closed), never a receipt.
3. `oss ship --approve <id>` performs fork→push→attest→verify→PR→ledger with **no prompts**, and the
   opened PR head OID equals the reviewed commit; the receipt verifies via `gh attestation verify`.
4. Unit tests cover the pure logic (recheck/duplicate parse, identity+DCO verifier, footer presence,
   PR-text assembly, approval-set parsing). All green.
5. A dry-run/plan mode prints the exact outbound actions without performing them.
6. Wall-clock for one clean mission (prepare→board): dominated by deps-install + one Codex loop, with
   **zero** separate receipt build and **zero** re-scans.

## 9. Non-goals

Auto-merge chasing; multi-party review/ship separation; fork auto-delete; a durable ship-transaction
journal; dual-vendor adversarial per mission; supporting low-reputation/hostile repos (escalation
only). Speed and the atom over completeness.

## 10. Open questions for the cross-vendor review

- OQ-1: Codex-in-container auth — mount an ephemeral scoped token vs. a host-side `docker exec` check
  wrapper with Codex on host. Which is simpler AND keeps the host isolated from repo *source* (not just
  test execution)? (Owner leans: Codex in container.)
- OQ-2: How much of the northset-oss bundle/ledger/parity is load-bearing for a *verifiable* public
  claim vs. cuttable packaging? Cut to the attestation subject + one ledger row, or keep more?
- OQ-3: Is one recheck (at ship) enough, or is a second recheck at prepare worth its one API call to
  avoid wasting a container run on an already-taken issue? (Owner leans: recheck at prepare too, it's cheap.)
- OQ-4: Batch review UX — a printed board + `ship --approve IDs`, vs. an interactive approve. Which
  best delivers "one review, one approval" without friction?
- OQ-5: Any invariant in §7 that is actually unsafe to cut for a solo operator publishing signed,
  public, third-party-facing claims? Attack the identity/attestation/footer/recheck set specifically.

---

## 11. v2 — post cross-vendor-review revisions (BINDING; overrides §3–§8 on conflict)

The Codex (gpt-5.6-sol) review returned DO-NOT-SHIP-AS-IS and was right about one thing that is NOT
ceremony but the atom's honesty: **if the fix-author controls the check environment, a signed
"check passed" proves nothing** (it can set `npm test`→`true`, gut assertions, delete the failing
test, mock the broken path). We do not sign false public claims. Adjudicated fixes below are lean;
the reviewer's re-imported fortress (full GPG/SSH signing, seccomp/AppArmor, a credential broker) is
rejected for a solo operator on reputable repos.

**R1 — Two environments, not one (THE core change).**
- **Author container:** network ON, Codex inside, iterates `{edit → run check → read}` for fast
  feedback, then `git commit -s` (identity mechanized). May be "dirty"; it only outputs a committed patch.
- **Verifier container:** FRESH from a pinned base-image digest, **no credentials**, started
  `--network=none` from the HOST, unprivileged. Applies ONLY the committed patch to a clean base;
  runs the check **command pinned from the spec/base (never author-supplied)**; captures output+exit.
  **This run is the receipt.** Deps come from a lockfile-digest cache so it is ~check-time, not a
  second full install. The author cannot touch this environment.

**R2 — Surface test tampering.** The receipt + board classify every changed file:
`source | added-test | modified-existing-test | check-or-CI-config`. Any `modified-existing-test`
or `check-or-CI-config` change is FLAGGED prominently on the board for the one human review.

**R3 — Canonical, content-addressed receipt.** One versioned object; the ledger row and page derive
from it. Subject includes: `repo, base_commit, patch_sha256, tested_tree_oid, commit_oid,
check_command, verifier_image_digest, dep_material_digest, exit=0, output_sha256, verifier_version`.
Publish the redacted output *separately* from the hashed original. CI attests this subject (provenance
of the record); the claim is "re-runnable, provenance-attested," not "third-party re-verified."

**R4 — Minimal content-binding chain (restored; cheap, not ceremony).**
`patch_sha256 → tested_tree_oid → commit_oid → pushed OID → PR head OID → attested subject`.
Assert equality before push, after push, and after PR creation. This is the product's integrity
boundary; cutting it lets us attest A while the PR contains B.

**R5 — One gate, bound to bytes.** `prepare` computes a **manifest digest** over every ready
mission's `{diff, commit_oid, receipt subject, exact PR title+body, repo, planned outbound actions}`.
Approval names that digest: `ship --approve <manifest-digest> [ids]`. Any regeneration/mutation/expiry
of the ready-pack changes the digest → requires fresh approval. Still ONE human decision — now
cryptographically bound to exactly what ships. Enforce a batch-size and per-repo cap.

**R6 — Ship is a resumable saga, not "atomic."** A tiny per-mission ship journal records
`{forked, pushed, attested, pr_opened, ledgered}`; `ship` is idempotent and resumes from the last
good step; a partial failure never leaves orphaned public state unre­conciled.

**R7 — Verify remote reality, not drafts.** After creation, assert the actual pushed commit OID and
the actual stored PR body (footer + correct receipt URL present) — not just the local draft.
INV-RECHECK becomes best-effort (recheck at prepare AND immediately before ship; a failed timeline
fetch is still fail-closed), described as duplicate-avoidance, not a guarantee.

**R8 — Cheap container hardening only.** Unprivileged user, `--no-new-privileges`, drop capabilities,
no Docker socket, no host mounts beyond the workspace, resource limits. A **separate revocable**
mission Codex login (not the founder's primary) in the author container; injected after dep install;
assume-stolen posture (its only value is model-budget abuse). No seccomp/AppArmor/user-namespace
project for now (reputable-repo escalation only).

**Updated invariants (replace §7):** INV-VERIFIER (receipt only from the fresh credential-free
network-off verifier running a spec-pinned check on the committed patch); INV-BIND (the R4 chain
holds at push/PR); INV-IDENTITY (aeziz@northset.ai + DCO, fail-closed); INV-FOOTER (verified on the
*stored* PR body); INV-APPROVAL (outbound only against an approved manifest digest); INV-NO-VERIFIER-CREDS.
INV-RECHECK downgraded to best-effort courtesy.

**Added acceptance tests (adversarial):** a fix that weakens/deletes an existing test is FLAGGED and
its receipt still only reflects the spec-pinned check on the committed patch; a receipt cannot be
produced from the author container; manifest-mutation after approval is rejected at ship; a simulated
partial ship resumes correctly; PR-body/footer verified post-creation.

**Resolved OQs:** OQ-1 Codex in the author container with a revocable mission login (not raw primary
token). OQ-2 keep one canonical content-addressed receipt + derived ledger row; cut duplicate bundle
presentation. OQ-3 recheck at prepare AND before ship, best-effort. OQ-4 non-interactive board +
`ship --approve <manifest-digest>`. OQ-5 do NOT cut the R4 binding; verification strength =
**local clean verifier** (founder decision), CI-side re-verification deferred.
```
