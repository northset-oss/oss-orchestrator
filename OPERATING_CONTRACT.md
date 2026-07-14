# Bounded OSS mission operating contract

## Review constitution

Each candidate receives one model-based qualification review against fixed mandatory gates. The
reviewer returns ACCEPT or REJECT and reports at most three blockers. It stops on verdict, budget
exhaustion or tool failure.

A code fix never reopens qualification. A material live-state change ends the attempt as STALE.
Infrastructure may retry once inside the original deadline; the deadline never resets. Every other
failure is terminal for that attempt. Success means that the predefined gates passed inside the
predefined budget, not that no additional concern could ever be found.

## Forward-only workflow

```text
DISCOVERED
  -> REJECTED
  -> QUALIFIED
       -> STALE | NOCHANGE | FAILED_BUDGET | FAILED_AUTHOR | FAILED_ORACLE
       -> READY
            -> DECLINED
            -> APPROVED
                 -> ABORTED_STALE
                 -> ABORTED_BUDGET
                 -> FAILED_INFRA_TERMINAL
                 -> ABORTED_AFTER_PUBLICATION
                 -> SHIPPED
```

There are no in-place backward transitions. A terminal ship journal stays terminal for the exact
same manifest. A newly approved changed manifest may start a replacement ship journal for that
mission only after the terminal journal is archived unchanged and referenced by the replacement.
Across mission IDs, one deterministic task ID identifies the issue-level unit of work. Attempt
sequences are contiguous, every earlier attempt must be terminal, and a task that reached `SHIPPED`
cannot acquire another attempt.

## Proof-of-pass economic identity

Schema-v2 preparation adds factual economic identity to the existing proof-of-pass receipt. It does
not create a second receipt. The signed bundle contains the task, all task-bound attempts through the
current one, observed stage durations, measured resource fields where available, verified change and
test scope, and evidence-linked public cost facts. Human approval happens later and is preserved in
an immutable top-level `approval.json`; upstream state remains the mutable `publication.json`.

No estimate, value hypothesis, ROI claim, market-rate substitution, or inferred provider charge is
permitted. A missing measurement is `null` or unavailable. A maintainer payment of zero records only
that no external maintainer payment occurred; it never means total economic cost was zero. A total
cost may be published only when every included component is known and every applicable component is
accounted for.

## Fixed bounds

| Operation | Bound |
| --- | ---: |
| Candidate qualification | 5 minutes |
| Finder invocation | 20 minutes |
| Finder model reviews | `min(40, requested x 4)` |
| Preparation | 60 minutes |
| Ship attempt | 60 minutes |
| Related PRs considered / hydrated | 12 / 8 |
| Infrastructure retries | 1 inside original deadline |
| Model-review retries | 0 |

Target service level: no individual qualification over five minutes, no preparation over thirty
minutes, no issue over fifty minutes before a terminal result, and no public partial state without
an explicit envelope.
