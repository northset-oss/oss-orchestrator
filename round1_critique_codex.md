Mode honored: DELEGATE_CRITIQUE

## CRITICAL findings

1. **INV-1 approvals are not bound to the reviewed code or the specific PR**

   - **Locator:** [DESIGN.md:25](/Users/aeziz-local/oss-orchestrator/DESIGN.md:25), [DESIGN.md:93](/Users/aeziz-local/oss-orchestrator/DESIGN.md:93)
   - **Claim:** `stage_history` records only `{stage, at}`. It has no actor identity, reviewed artifact digest, authorization generation, target base/ref, fork branch, or frozen PR title/body.
   - **Evidence/interleaving:** The owner reviews patch `h1`; before receipt creation, the mutable patch/workspace changes to `h2`; the receipt tests `h2`; the founder authorizes a proposal; `push` merely finds historical `reviewed` and `authorized` strings and proceeds. A reset/rework that preserves append-only history has the same defect.
   - **Consequence:** An unreviewed change or a materially different PR can pass INV-1—the cardinal failure.
   - **Minimal fix:** Make review and authorization content-addressed records binding authenticated actor, mission generation, exact head/tree/patch and receipt digests, and a frozen PR manifest. Any mutation must invalidate both approvals. Owner judgment is required on how founder identity and authorization are authenticated.

2. **INV-2 is checked after the PR is already outbound, and its stated comparison cannot currently be implemented**

   - **Locator:** [DESIGN.md:70](/Users/aeziz-local/oss-orchestrator/DESIGN.md:70), [DESIGN.md:95](/Users/aeziz-local/oss-orchestrator/DESIGN.md:95), [pipeline.mjs:458](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:458), [executor.mjs:669](/Users/aeziz-local/northset-oss/lib/executor.mjs:669)
   - **Claim:** The sequence opens the PR and only then verifies `head==tested`. Moreover, the actual receipt records source commit, base/pre-check tree digests, and patch hash; it does not produce the design’s `receipt.patch_commit`.
   - **Evidence/interleaving:** A stale/raced fork ref points to `h2`; the reviewed/tested head is `h1`; the PR is opened from `h2`; the subsequent comparison detects the mismatch only after the unreviewed PR exists.
   - **Consequence:** The cardinal invariant is observably violated even if the system immediately marks the mission failed.
   - **Minimal fix:** Define a canonical tested-code identity supported by the real receipt, then verify the live remote fork ref against that identity before PR creation. Fence the branch against other writers. The post-open check should be defense-in-depth only.

3. **Pre-authorization receipts contaminate one shared mutable northset-oss checkout**

   - **Locator:** [DESIGN.md:66](/Users/aeziz-local/oss-orchestrator/DESIGN.md:66), [DESIGN.md:86](/Users/aeziz-local/oss-orchestrator/DESIGN.md:86), [pipeline.mjs:361](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:361), [pipeline.mjs:428](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:428)
   - **Claim:** Serializing `receipt` and `push` operations does not isolate the state left between them.
   - **Evidence/interleaving:** M1’s receipt writes its mission, `index.json`, and site, then releases the lock while awaiting founder authorization. M2 does likewise, rebuilding the ledger to include both. M1 later acquires the lock and commits the current shared checkout. A broad stage can include M2’s unauthorized bundle; even exact path staging can publish an index/site referencing M2. The bundle-only `HEAD~1` assertion does not detect ledger contamination.
   - **Consequence:** M1’s authorized push can send M2 state to the public repo without M2 founder authorization.
   - **Minimal fix:** Build receipts in per-mission disposable checkouts. At authorized shipping, start from a verified clean remote tip, add exactly one frozen mission, regenerate the ledger from only committed state plus that mission, and assert the complete commit diff and ledger closure.

## HIGH findings

4. **The “single writer” claim does not fence resumed or duplicate schedulers**

   - **Locator:** [DESIGN.md:46](/Users/aeziz-local/oss-orchestrator/DESIGN.md:46), [DESIGN.md:102](/Users/aeziz-local/oss-orchestrator/DESIGN.md:102), [DESIGN.md:141](/Users/aeziz-local/oss-orchestrator/DESIGN.md:141)
   - **Claim:** `flock` around board writes protects bytes, not scheduling or external effects. There is no scheduler lease, epoch fencing, or durable `pushing` claim.
   - **Evidence/interleaving:** Scheduler A loads `authorized` and begins shipping. A resumed scheduler B also loads `authorized`. Even if the northset lock serializes them, B can act on its stale eligibility after A releases the lock or crashes before updating the board.
   - **Consequence:** Duplicate PR attempts, attestations, ledger writes, Codex runs, or stale board overwrites remain possible.
   - **Minimal fix:** Add an exclusive scheduler lease plus per-mission claims carrying a fencing epoch. Every worker and irreversible operation must reject stale epochs after acquiring its resource lock.

5. **The composite `authorized → shipped` stage has no durable operation journal**

   - **Locator:** [DESIGN.md:70](/Users/aeziz-local/oss-orchestrator/DESIGN.md:70), [DESIGN.md:75](/Users/aeziz-local/oss-orchestrator/DESIGN.md:75)
   - **Claim:** A prose promise to “detect prior partial work” is insufficient for eight external suboperations.
   - **Evidence/interleavings:** PR creation can succeed while its response or board write fails; receipt push can succeed before the attestation ID is recorded; fork push can succeed before PR creation fails; PR opening can succeed before the ledger row fails. The board schema lacks durable intent/result records, exact remote refs, attestation run/subject, and deterministic PR lookup coordinates.
   - **Consequence:** Resume can duplicate actions, adopt the wrong external object, or leave an open PR represented as merely `authorized`.
   - **Minimal fix:** Journal each irreversible intent and observed result durably, with deterministic branch/tag identities and exact remote reconciliation rules. Ambiguous results must stop for owner resolution rather than rerun the whole stage.

6. **The real pipeline can corrupt mission/index/site state on both ordinary failure and process death**

   - **Locator:** [pipeline.mjs:322](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:322), [pipeline.mjs:428](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:428), [pipeline.mjs:450](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:450), [pipeline.mjs:467](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:467)
   - **Claim:** Rollback restores only the mission directory, not `index.json` or the site.
   - **Evidence/interleaving:** Rename of `index.json` succeeds; site rename fails; catch removes/restores the mission but leaves the new index installed. SIGKILL/power loss after any rename bypasses catch entirely.
   - **Consequence:** The shared checkout becomes internally inconsistent and a later otherwise-valid push can publish corrupted or unintended state. INV-9 is false for this grounding implementation.
   - **Minimal fix:** Treat mission, index, and site as one recoverable transaction—preferably in a disposable git worktree with a validated commit—or snapshot and restore all three with a crash-recovery journal.

7. **INV-4 and the workflow inspect only `HEAD~1`, not the range actually pushed**

   - **Locator:** [DESIGN.md:99](/Users/aeziz-local/oss-orchestrator/DESIGN.md:99), [attest-bundle.yml:35](/Users/aeziz-local/northset-oss/.github/workflows/attest-bundle.yml:35), [attest-bundle.yml:52](/Users/aeziz-local/northset-oss/.github/workflows/attest-bundle.yml:52)
   - **Claim:** “One mission per commit” is not “one mission per network push.”
   - **Evidence/interleaving:** M1 is committed locally; the process crashes before push. M2 is later committed and one `git push` sends both commits. The design assertion and workflow examine only M2’s `HEAD~1` diff, so M1 lands without being selected for attestation.
   - **Consequence:** A public receipt can be silently unattested; contaminated earlier commits can also escape the guard.
   - **Minimal fix:** Fetch and pin the expected remote tip, require the pushed range to be exactly the intended commit/range, and inspect the GitHub event’s full `before..after` range.

8. **INV-3 occurs after multiple outbound actions and still has a PR-open TOCTOU gap**

   - **Locator:** [DESIGN.md:72](/Users/aeziz-local/oss-orchestrator/DESIGN.md:72), [DESIGN.md:97](/Users/aeziz-local/oss-orchestrator/DESIGN.md:97)
   - **Claim:** The statement “fail → skipped, nothing pushed” contradicts the declared order.
   - **Evidence/interleaving:** Receipt push/attestation and fork branch push happen before final recheck. If the issue closes or a competing PR appears, the mission becomes `skipped` only after those outbound effects. Another contributor can also act between recheck and PR creation.
   - **Consequence:** Orphaned public receipts/branches and competing or duplicate PRs are possible.
   - **Minimal fix:** Recheck before any outbound effect and again immediately before PR creation; coordinate every local actor by repo/fork lock. Owner judgment is required on the residual race with external actors.

9. **Automated fork deletion can race PR creation and silently close a real PR**

   - **Locator:** [DESIGN.md:123](/Users/aeziz-local/oss-orchestrator/DESIGN.md:123), [DESIGN.md:131](/Users/aeziz-local/oss-orchestrator/DESIGN.md:131)
   - **Claim:** A live “zero open PRs” query and delete are separate operations, while cleanup is not coordinated with shipping.
   - **Evidence/interleaving:** Cleanup observes zero PRs for a fork; another mission opens a PR from that fork; cleanup then deletes the fork using its stale result.
   - **Consequence:** The newly opened PR is silently closed, directly threatening maintainer trust and the founder’s identity.
   - **Minimal fix:** Defer auto-delete from v1. If retained later, share a per-fork lock with all branch/PR creation, use a grace period and immediate second check, and surface the irreducible external race for owner acceptance. One successful live deletion is not evidence of race safety.

10. **Receipt retries can replace and double-attest a mission under one stable ID**

   - **Locator:** [pipeline.mjs:353](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:353), [pipeline.mjs:363](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:363), [executor.mjs:669](/Users/aeziz-local/northset-oss/lib/executor.mjs:669), [attest-bundle.yml:105](/Users/aeziz-local/northset-oss/.github/workflows/attest-bundle.yml:105)
   - **Claim:** Pipeline output is nondeterministic across reruns, `force` permits replacement, and the workflow overwrites the fixed mission release asset with `--clobber`.
   - **Evidence/interleaving:** Receipt creation succeeds but board persistence fails. Retry either blocks on `MISSION_EXISTS` or uses `force`, generating new timestamps/durations and digest. If both versions reach main, both can be attested while the same release tag points only to the clobbered latest asset.
   - **Consequence:** Multiple attestations can exist for different bytes under one mission identity, and resume may verify the wrong one.
   - **Minimal fix:** Make a mission ID immutable once published; reconcile an existing exact bundle digest rather than regenerate; record and verify attestation subject digest, source commit, and workflow run; prohibit clobbering a different digest.

11. **The promised review-backlog throttle does not exist**

   - **Locator:** [DESIGN.md:11](/Users/aeziz-local/oss-orchestrator/DESIGN.md:11), [DESIGN.md:80](/Users/aeziz-local/oss-orchestrator/DESIGN.md:80)
   - **Claim:** `C` limits concurrent production but does not stop new coding when verified/adversarially-reviewed work awaits the owner.
   - **Evidence:** No queue-depth, queue-age, owner-review capacity, authorization backlog, or freshness threshold affects scheduler eligibility.
   - **Consequence:** At 5–10 workers the system can accumulate stale diffs until the owner either rushes or carries an ever-growing review burden; degradation is silent.
   - **Minimal fix:** Add a hard WIP ceiling and age limit for owner-review-ready missions that blocks new `code` starts. Ramp thresholds require owner judgment.

12. **INV-10 contradicts the actual Codex wrapper’s raw log persistence**

   - **Locator:** [DESIGN.md:110](/Users/aeziz-local/oss-orchestrator/DESIGN.md:110), [codex_implement.sh:137](/Users/aeziz-local/.claude/model-delegation/codex_implement.sh:137), [codex_implement.sh:209](/Users/aeziz-local/.claude/model-delegation/codex_implement.sh:209)
   - **Claim:** The wrapper stores raw stderr, JSONL event streams, and final output; no redaction step is present.
   - **Evidence:** A tool command, test, prompt-injected repository instruction, or model response can echo an inherited secret or sensitive local path directly into persistent artifacts.
   - **Consequence:** Parallelism multiplies secret/privacy exposure and retention.
   - **Minimal fix:** Use secret-free clean clones and a minimal environment, restrict log permissions/retention, and scan/redact before persistence. Receipt leak-grep does not protect these private logs.

## MEDIUM findings

13. **Successful receipt commands are opt-in, despite INV-8 saying failure always blocks**

   - **Locator:** [DESIGN.md:105](/Users/aeziz-local/oss-orchestrator/DESIGN.md:105), [pipeline.mjs:294](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:294), [pipeline.mjs:414](/Users/aeziz-local/northset-oss/lib/pipeline.mjs:414)
   - **Claim/evidence:** The pipeline checks command success only when `options.requireSuccess === true`; the design does not make that integration argument an asserted contract.
   - **Consequence:** An omitted option can produce and later attest a receipt containing failed/timed-out commands.
   - **Minimal fix:** Require success unconditionally for this orchestrator path and test that omission cannot silently weaken the gate.

14. **The adversarial-review “redaction” and independence are unenforced**

   - **Locator:** [DESIGN.md:112](/Users/aeziz-local/oss-orchestrator/DESIGN.md:112)
   - **Claim/evidence:** The design names allowed inputs but defines no mechanical allowlist, isolated session, board-access restriction, or redaction test. Both skeptics receive the same owner-authored frozen spec and verification output, creating a shared anchoring/common-mode failure.
   - **Consequence:** Two apparently independent approvals can repeat the same blind spot; owner review may be biased by correlated “no issue” findings.
   - **Minimal fix:** Run fresh isolated skeptic contexts from an explicit allowlisted artifact bundle, prohibit board/prior-finding access, and preserve a genuinely blind first pass. This still cannot replace full owner diff review.

15. **Verification freshness is not tied to the upstream base**

   - **Locator:** [DESIGN.md:52](/Users/aeziz-local/oss-orchestrator/DESIGN.md:52), [DESIGN.md:95](/Users/aeziz-local/oss-orchestrator/DESIGN.md:95)
   - **Claim/evidence:** Final recheck covers issue/assignment/competing PR state, while INV-2 compares only the head. At larger queues, the upstream base can advance materially between verification, review, authorization, and PR opening.
   - **Consequence:** A previously green head can open against an untested current base or newly conflict, with risk increasing as review backlog grows.
   - **Minimal fix:** Bind and check target base SHA plus freshness TTL before authorization/open; base movement should return the mission to verification and, when material, owner review.

## LOW finding

16. **Non-core automation expands v1’s irreversible surface prematurely**

   - **Locator:** [DESIGN.md:123](/Users/aeziz-local/oss-orchestrator/DESIGN.md:123), [DESIGN.md:147](/Users/aeziz-local/oss-orchestrator/DESIGN.md:147)
   - **Claim/evidence:** Automatic fork deletion, rendered-ledger synchronization, and C=10 resource logic are specified before the start-at-3 shipping transaction has a sound approval binding or recovery protocol.
   - **Consequence:** More state machines and credentials obscure validation of the cardinal path.
   - **Minimal fix/owner question:** For v1, consider deferring auto-delete and scale-10 machinery until three-way concurrency has demonstrated crash/restart and duplicate-scheduler safety. This is an owner scope decision.

## Review record

- **Files changed:** None.
- **Web search:** Not used.
- **Checks performed:** Static, read-only inspection only; no tests or workflow execution because this invocation is findings-only.
- **Commands run:** `wc -l` over the five scoped files; numbered reads using `nl -ba` and `sed` over all scoped content; `rg -n` for approval, locking, head-binding, redaction, success-gate, attestation, and retry terms. One broad `rg --files` also encountered expected macOS permission/time-out errors outside the scoped repositories; it did not affect the reviewed files.
- **Residual uncertainty:** The orchestrator implementation does not yet exist, so findings about locking, reconciliation, and authorization mechanisms reflect missing enforceable design contracts. A future implementation could address them, but the frozen design currently does not require that behavior.

**Single highest-risk defect:** INV-1 treats unauthenticated, stale stage names as proof that the owner reviewed the current bytes and the founder authorized the exact current PR. That permits the cardinal unreviewed-outbound failure even when every stated state transition appears valid.