import assert from 'node:assert/strict';
import test from 'node:test';

import {lintPrOverclaims, normalizedPrClaimText, reviewPatch} from './review-patch.mjs';

function spec(overrides = {}) {
  return {
    mission_id: 'M-100', work_category: 'defect_fix', allow_modified_existing_tests: false,
    oracle: {test_paths: ['test/parser-regression.test.mjs'], base_failure_contains: 'retains the final token'},
    qualification: {source_evidence: ['src/parser.mjs:7 — return tokens.slice(0, -1);']},
    ...overrides,
  };
}

const patch = `diff --git a/src/parser.mjs b/src/parser.mjs
index 1111111..2222222 100644
--- a/src/parser.mjs
+++ b/src/parser.mjs
@@ -1 +1 @@
-return tokens.slice(0, -1);
+return tokens;
diff --git a/test/parser-regression.test.mjs b/test/parser-regression.test.mjs
new file mode 100644
--- /dev/null
+++ b/test/parser-regression.test.mjs
@@ -0,0 +1 @@
+test('retains the final token', () => {});
`;

test('deterministic patch review accepts source plus an oracle-bound added regression', () => {
  const result = reviewPatch({
    spec: spec(), patch,
    classes: [{path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser-regression.test.mjs', class: 'added-test'}],
    prBody: 'Fixes #12\n\nContributor self-run; not maintainer verification.',
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blocking_reasons, []);
  assert.match(result.review_digest, /^sha256:[0-9a-f]{64}$/);
});

test('fast-lane patch review blocks elevated file classes, existing tests and test-only defect fixes', () => {
  assert.equal(reviewPatch({
    spec: spec(), patch,
    classes: [{path: 'package-lock.json', class: 'lockfile'}, {path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser-regression.test.mjs', class: 'added-test'}],
    prBody: 'Contributor self-run; not maintainer verification.',
  }).ready, false);
  assert.equal(reviewPatch({
    spec: spec(), patch,
    classes: [{path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser-regression.test.mjs', class: 'modified-existing-test'}],
    prBody: 'Contributor self-run; not maintainer verification.',
  }).ready, false);
  assert.match(reviewPatch({
    spec: spec(), patch,
    classes: [{path: 'test/parser-regression.test.mjs', class: 'added-test'}],
    prBody: 'Contributor self-run; not maintainer verification.',
  }).blocking_reasons.join(' '), /production source/i);
  assert.match(reviewPatch({
    spec: spec(), patch,
    classes: [{path: 'src/not-the-patch.mjs', class: 'source'}, {path: 'test/parser-regression.test.mjs', class: 'added-test'}],
    prBody: 'Contributor self-run; not maintainer verification.',
  }).blocking_reasons.join(' '), /exact patch paths/i);
  const markerOnlyInSource = patch
    .replace('+return tokens;', "+return 'retains the final token';")
    .replace("+test('retains the final token', () => {});", "+test('parser regression', () => {});");
  assert.match(reviewPatch({
    spec: spec(), patch: markerOnlyInSource,
    classes: [{path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser-regression.test.mjs', class: 'added-test'}],
    prBody: 'Contributor self-run; not maintainer verification.',
  }).blocking_reasons.join(' '), /oracle test path/i);

  const missingEvidence = reviewPatch({
    spec: spec({qualification: {source_evidence: []}, source_evidence: ['src/parser.mjs:7 — stale fallback']}),
    patch,
    classes: [{path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser-regression.test.mjs', class: 'added-test'}],
    prBody: 'Contributor self-run; not maintainer verification.',
  });
  assert.match(missingEvidence.blocking_reasons.join(' '), /source evidence/i);

  const unrelatedEvidence = reviewPatch({
    spec: spec({qualification: {source_evidence: ['src/other.mjs:1 — unrelated']}}),
    patch,
    classes: [{path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser-regression.test.mjs', class: 'added-test'}],
    prBody: 'Contributor self-run; not maintainer verification.',
  });
  assert.match(unrelatedEvidence.blocking_reasons.join(' '), /source-evidence path/i);
});

test('PR overclaim lint is conservative and preserves the contributor claim boundary', () => {
  assert.deepEqual(lintPrOverclaims('Contributor self-run; not maintainer verification.'), []);
  assert.match(lintPrOverclaims('This is maintainer approved and production ready.').join(' '), /maintainer approval|production readiness/i);
  assert.match(lintPrOverclaims('This has the maintainer\'s sign-off and is suitable for production.').join(' '), /maintainer approval|production readiness/i);
  assert.match(lintPrOverclaims('All checks pass.').join(' '), /unscoped all-checks/i);
  assert.match(lintPrOverclaims('All tests passed.').join(' '), /unscoped all-checks/i);
  assert.match(lintPrOverclaims('The change is secure.').join(' '), /security/i);
  assert.match(lintPrOverclaims('This patch is secure. Does not prove security.').join(' '), /security/i);
  assert.match(lintPrOverclaims('This patch has no vulnerabilities. Does not prove security.').join(' '), /security/i);
  assert.match(lintPrOverclaims('This fix improves security and resolves a vulnerability. Does not prove security.').join(' '), /security/i);
  assert.match(lintPrOverclaims('The vulnerability has been fixed. Does not prove security.').join(' '), /security/i);
  assert.match(lintPrOverclaims('This implementation is correct and high quality.').join(' '), /quality|correctness/i);
  assert.match(lintPrOverclaims('This change correctly fixes the parser and improves code quality.').join(' '), /quality|correctness/i);
  assert.match(lintPrOverclaims('The maintainers will merge this patch.').join(' '), /merge/i);
  assert.match(lintPrOverclaims('This patch is expected to be merged.').join(' '), /merge/i);
  assert.equal(normalizedPrClaimText('  Fix parser.\n\nContributor   self-run.  '), 'Fix parser. Contributor self-run.');
});
