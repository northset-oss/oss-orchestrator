## Summary

- Fix #1373 by focusing the search input synchronously while `showDropdown()` is still in the user-interaction path.
- Keep dropdown rendering, measurement, event dispatch, and choice highlighting deferred to `requestAnimationFrame`.
- Preserve `preventInputFocus` behavior.
- Add a regression test for synchronous focus timing.

Fixes #1373

## Why

On affected iOS Safari and WebView versions, deferring `input.focus()` into `requestAnimationFrame` can move it outside the WebKit user-interaction context needed to show the software keyboard. The input can appear focused while the user still has to tap it again before typing.

## Testing

- `npm run test:unit -- test/scripts/choices.test.ts -t showDropdown` — passed: 8 tests.
- `npm run test:unit -- test/scripts/choices.test.ts` — passed: 150 tests.
- `npx eslint src/scripts/choices.ts test/scripts/choices.test.ts` — passed.
- Manual iOS-device testing was not performed.

---
AI assistance was used. This change was reviewed by Northset, and I accept responsibility for this submission.

<!-- northset-receipt:M-1014:start -->
### Verification

[Northset proof-of-pass receipt M-1014](https://northset-oss.github.io/verification-pilot/receipts/M-1014/)  
Contributor self-run; not maintainer verification.
<!-- northset-receipt:M-1014:end -->
