## Summary

- Render the opponent's hand facedown in Corp and Runner replay views.
- Leave existing Spectator View and live-game hand visibility unchanged.
- Apply the visibility decision to the normal and expanded hand renderers.
- Remove both added tests in response to maintainer feedback; the PR now changes only `board.cljs`.

## Tests

- `npm run cljs:release` — passed against current `master` (258 files, 0 warnings).
- Not run: manual replay UI verification.

Fixes #6551

---
AI assistance was used. This change was reviewed by Northset, and I accept responsibility for this submission.

<!-- northset-receipt:M-1048:start -->
### Verification

[Northset proof-of-pass receipt M-1048](https://northset-oss.github.io/verification-pilot/receipts/M-1048/)  
Contributor self-run; not maintainer verification.
<!-- northset-receipt:M-1048:end -->
