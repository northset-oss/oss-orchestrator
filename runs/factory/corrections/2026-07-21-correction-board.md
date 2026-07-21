# OSS factory published-PR correction board

Board: `sha256:91eb3c9fa71cc28707bf7294295cdc40ff7f06794328e01c4d5608217c300a9b`

## M-1014 — Choices-js/Choices#1373

- Exact base: `440641be900072991383c05ae66589e0d4c34f6e`
- Existing head to replace: `e98f6d2eac6d33b08b6914c0bb566d68ba2fd70a`
- Corrected commit: `403d2ea215222f41d32595fc01c35710f96e6d2c`
- Tested tree: `81e88b2108166a490d2c4e2dda33623d1bdf4255`
- Patch: `sha256:bf1b67a719dfa7a588dc679b0c206981329539b217ab565dd4738b9684f70545`
- Diff: 10 insertions, 4 deletions in `src/scripts/choices.ts` and the existing `test/scripts/choices.test.ts`
- Clean verifier: base failed and corrected head passed the focused regression; full file 150/150 and targeted ESLint passed
- Limitation: no manual iOS-device test

The commit and PR body now explain why synchronous focus is required for affected iOS Safari/WebView software keyboards.

## M-1048 — mtgred/netrunner#6551

- Exact base: `e5ca7339c5566808b1ccd190d088ad0caec0031f`
- Existing head to replace: `d820436c05cf826d54ec1f08f7a402ec85313c8c`
- Corrected commit: `16aa11b96d9e4d88afe8c6c4c5306de9ec8850de`
- Tested tree: `e3d89b854084a7d8b2dea4d7179a1bfddca09723`
- Patch: `sha256:755eb8d43c01147b2adfab6266dde193897d7cde6e8e6c690d00681037848530`
- Diff: 14 insertions, 3 deletions in `src/cljs/nr/gameboard/board.cljs` only
- Clean verifier: base failed and corrected head passed the network-off implementation predicate; `npm run cljs:release` passed with 258 files and 0 warnings
- Limitation: no manual replay UI test

Both maintainer-rejected test files are removed. The exact PR text and public actions are bound inside `2026-07-21-correction-board.json`; publication requires proof replacement, exact-old-head force-with-lease, PR-body update/readback, maintainer reply, and receipt reconciliation.

Approval request: **Approve and publish M-1014 and M-1048 on board `sha256:91eb3c9fa71cc28707bf7294295cdc40ff7f06794328e01c4d5608217c300a9b`.**
