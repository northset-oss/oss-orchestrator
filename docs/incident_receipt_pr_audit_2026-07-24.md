# Incident receipt and existing-PR audit

Audit time: `2026-07-24T00:22:11Z`
Mode: live read-only GitHub and Pages inspection; no remote mutation

## Public source and deployment snapshot

- Public ledger `main`: `0c011e6b33f79d7345f55eac49e4f0624a93536e`
- Public ledger `receipts`: `4984fbc753bee8210fff33d5f4d5d20321c82b7e`
- Rendered `generated_at`: `2026-07-23T19:34:13Z`
- Live M-012 page SHA-256:
  `sha256:a8a4c6dae8a1c22da658d1212ce74a25793af9edf05d48c6b3b4c1a18baf3cb2`

The live homepage, ledger, M-012 page, and doc-kit repository page were byte-identical to a clean
render from those public refs. This proves the stale/soliciting page was deployed from the named
public sources; it does not clear the incident because corrected bytes have not been deployed.

## All public receipts

The merged public ledger contained 78 receipts: 34 canonical and 44 factory receipts. Seventy-four
had upstream PRs, and all 74 were checked against live GitHub in a batched read.

- Local upstream states: 39 open, 7 closed unmerged, 28 merged.
- Live upstream states: 38 open, 8 closed unmerged, 28 merged.
- Stored publication head versus live head mismatches: zero.
- Stale state and missing closure: `M-012` only.
- Receipt/tested-head drift: `M-011`, `M-012`, `M-020`, `M-021`, `M-1011`, `M-1021`,
  `M-105`, `M-1056`, `M-112`.
- Conclusive CI claim combined with drift: all of the preceding except pending `M-021`.
- Live nonterminal workflow: `M-021`, `UI Tests`.
- Live review decisions not recorded locally: `M-1025` changes requested; `M-1027`, `M-1029`,
  `M-1034`, `M-1056`, and `M-1060` approved.
- Stale decision URL: `M-012`.
- Inexact local closure timestamp: `M-1018`, `M-1020`, `M-1028`, `M-1034`, `M-1047`,
  `M-1050`, `M-1052`, `M-1061`.

The old public render contained 41 direct-receipt CI agreement/disagreement claims, 68 repository
pages carrying agreement aggregation, and the homepage aggregate: 110 claim-bearing HTML surfaces.
All 78 receipt pages, all 68 repository pages, and the homepage carried a CTA or mailto surface.

For M-012 specifically, the source observation had declared success before all current required
contexts existed: 22 of 24 current contexts completed or appeared after the old observation. This is
the frozen motivating case for the new nonterminal/head-binding validator.

## Existing-open PR inventory

Thirty-nine local records were believed open. Live truth was 38 open and M-012/PR #901 closed.
All 39 live head OIDs matched the local recorded head OIDs.

- Bodies with an old Northset receipt link: 37.
- Bodies with `reviewed by Northset`: 24.
- Bodies with `checkable in ~30 seconds`: 5 (`M-1046`, `M-1064`, `M-1065`, `M-1066`,
  `M-1069`).
- Unresolved inline review threads among the 38 open PRs: zero.
- Open PRs requiring substantive owner action: one, `M-1025`, whose maintainer requires the owner
  to perform the manual Thunderbird test and write any response personally.
- `M-1037` is deferred by the maintainer until mid-August and already acknowledged.
- `M-1040`'s maintainer question was answered.
- `M-1048`'s harmful-test objection was fixed and answered.

The old receipt-bearing bodies must not be mass-edited. Their destinations are neutralized centrally;
individual upstream body changes occur only naturally or on maintainer request.

## PR #901 and offer no-send checks

PR #901 had 10 comments, 14 reviews, and 41 timeline events. The finalized owner apology draft did
not appear in any comment or review. It has not been posted.

All 13 offer-target PRs were checked for comments, review bodies, and inline review comments after
the draft cutoff `2026-07-22T21:50:49.946Z`:

- six post-cutoff events, all on `goptics/vizb#245`;
- zero authored by `AysajanE`;
- zero mentioning Northset.

This proves no offer was sent through the recorded factory transport or the target GitHub threads.
A read-only Gmail Sent Mail audit on 2026-07-24 also returned no matches for either the 13 target
repositories and maintainers or the independent offer-language query after the draft cutoff.

## Metrica relationship classification

Read-only repository metadata showed `Metrica-Academy/northset-verified-intake` as a private
organization-owned repository created and last pushed on 2026-04-11. Commit history was not
accessible to the authenticated account, and no local intake, ownership, independent-request, or
authorized-requester evidence was found.

Its demand-accounting classification is therefore:

```text
INTERNAL_OR_UNVERIFIED_RELATIONSHIP
```

It contributes zero independent inbound-demand evidence unless ownership and independent initiation
are later proven.

## External boundary

This audit does not authorize closing issue #1, posting on PR #901, submitting the GitHub Support
inquiry, pushing either repository, deploying Pages, or clearing the publication pause.
