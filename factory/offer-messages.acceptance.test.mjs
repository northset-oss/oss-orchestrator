import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OFFER_MESSAGES,
  affordanceLine,
  draftOfferMessage,
  issueChoiceOffer,
  postMergeOffer,
  rejectionHarvestOffer,
  selfVerifyOffer,
} from './offer-messages.mjs';

const NO_DASH = /[—–]/;
const ONLY_SENTENCES = /[.?]["']?$/;

test('no rendered message contains an em dash or en dash', () => {
  const rendered = [
    selfVerifyOffer(),
    postMergeOffer({prNumber: 123, prAgeDays: 11, firstTimeContributor: true, ciState: 'PENDING'}),
    issueChoiceOffer(),
    rejectionHarvestOffer({maintainer: 'octocat'}),
    affordanceLine(),
  ];
  for (const message of rendered) assert.doesNotMatch(message, NO_DASH, `dash in: ${message}`);
});

test('every message ends on a complete sentence', () => {
  const endings = [
    selfVerifyOffer(),
    postMergeOffer({prNumber: 7, prAgeDays: 3}),
    issueChoiceOffer(),
    rejectionHarvestOffer({maintainer: 'octocat'}),
    affordanceLine(),
  ];
  for (const message of endings) {
    const lastLine = message.trim().split('\n').at(-1);
    assert.match(lastLine, ONLY_SENTENCES, `not a full sentence: ${lastLine}`);
  }
});

test('self-verify offer names the label and the fork-CI reason', () => {
  const message = selfVerifyOffer();
  assert.match(message, /comes from a fork/);
  assert.match(message, /add the northset-verify label/);
});

test('post-merge offer names the exact PR and adapts the situation clause', () => {
  const firstTimer = postMergeOffer({prNumber: 42, prAgeDays: 1, firstTimeContributor: true, ciState: 'EXPECTED'});
  assert.match(firstTimer, /PR #42, from a first-time contributor, has been open about 1 day and its CI hasn't run yet\./);

  const failing = postMergeOffer({prNumber: 9, prAgeDays: 20, crossRepository: true, ciState: 'FAILURE'});
  assert.match(failing, /PR #9, from an outside contributor, has been open about 20 days and its CI is currently failing\./);

  const plain = postMergeOffer({prNumber: 5, prAgeDays: 0, ciState: 'SUCCESS', hasReview: false});
  assert.match(plain, /PR #5 is open and it is waiting on a first review\./);
});

test('post-merge offer requires a real PR number', () => {
  assert.throws(() => postMergeOffer({prAgeDays: 3}), /prNumber must be a positive integer/);
  assert.throws(() => postMergeOffer({prNumber: 0}), /prNumber must be a positive integer/);
});

test('rejection-harvest greets the specific maintainer and leads with respect', () => {
  const message = rejectionHarvestOffer({maintainer: '@octocat'});
  assert.match(message, /^Hi @octocat,\n\n/);
  assert.match(message, /I completely understand your position on the patches/);
  assert.throws(() => rejectionHarvestOffer({}), /maintainer is required/);
});

test('draftOfferMessage marks foreign-code offers as consent-required, not boundary-gated', () => {
  const foreign = draftOfferMessage('post_merge', {prNumber: 3, prAgeDays: 2});
  assert.equal(foreign.send_gated, false);
  assert.equal(foreign.foreign_code, true);
  assert.equal(foreign.requires, 'recorded PR-scoped maintainer consent before foreign-runner run');

  const safe = draftOfferMessage('self_verify', {});
  assert.equal(safe.send_gated, false);
  assert.equal(safe.foreign_code, false);
  assert.equal(safe.requires, null);

  assert.equal(OFFER_MESSAGES.rejection_harvest.gated, false);
  assert.equal(OFFER_MESSAGES.rejection_harvest.foreign_code, true);
  assert.throws(() => draftOfferMessage('nope', {}), /unknown offer message/);
});
