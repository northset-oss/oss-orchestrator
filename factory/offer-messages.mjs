#!/usr/bin/env node

// Canonical send-able outreach message catalog for the Level-1 offer funnel.
// House style (enforced by the acceptance test): no em dashes, complete sentences,
// warm and specific. Every renderer requires its personalization slots, so a message
// can never be sent generic. The dossier funnel attaches these to identified offers.

import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const NORTHSET_VERIFY_LABEL = 'northset-verify';

// The sacrificial-boundary gate was signed off GO on 2026-07-22
// (northset-oss/docs/foreign-run-gate-evidence-2026-07-22.md), so foreign-PR offers are no
// longer boundary-blocked. They still run a stranger's code, so each requires recorded
// PR-scoped maintainer consent before foreign-runner.mjs run executes anything.
export const FOREIGN_CODE_CONSENT = 'recorded PR-scoped maintainer consent before foreign-runner run';

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required to personalize this message`);
  }
  return value.trim();
}

function requirePrNumber(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('prNumber must be a positive integer so the message names a specific PR');
  }
  return value;
}

// Move 1. Posted in a live PR thread on one of our own fork PRs. Safe to send now.
export function selfVerifyOffer({label = NORTHSET_VERIFY_LABEL} = {}) {
  return [
    "Since this PR comes from a fork, your CI won't run until you approve it.",
    'If it helps, I can run your full check suite against this exact commit in a clean, isolated' +
      ' environment and post back a short signed summary of what passed, so you can see the result' +
      ' before you decide.',
    "I'll only do this if you'd like me to.",
    `Just tag me, or simply add the ${label} label.`,
  ].join(' ');
}

function contributorClause({firstTimeContributor, crossRepository}) {
  if (firstTimeContributor) return ', from a first-time contributor,';
  if (crossRepository) return ', from an outside contributor,';
  return '';
}

function ageClause(prAgeDays) {
  if (!Number.isInteger(prAgeDays) || prAgeDays < 1) return 'is open';
  return `has been open about ${prAgeDays} ${prAgeDays === 1 ? 'day' : 'days'}`;
}

function situationClause({ciState, hasReview}) {
  const state = String(ciState ?? '').toUpperCase();
  if (['EXPECTED', 'PENDING', ''].includes(state)) return "its CI hasn't run yet";
  if (['ERROR', 'FAILURE'].includes(state)) return 'its CI is currently failing';
  if (hasReview === false) return 'it is waiting on a first review';
  return 'it has been waiting for a while';
}

// Move 3. Sent after we merge a fix, offering to verify a contributor's stuck PR.
// Foreign code: requires recorded PR-scoped consent before the run (boundary gate cleared 2026-07-22).
export function postMergeOffer({
  prNumber,
  prAgeDays,
  firstTimeContributor = false,
  crossRepository = false,
  ciState = '',
  hasReview = null,
} = {}) {
  const number = requirePrNumber(prNumber);
  const descriptor = contributorClause({firstTimeContributor, crossRepository});
  const age = ageClause(prAgeDays);
  const situation = situationClause({ciState, hasReview});
  return [
    'Thanks for merging the fix, I appreciate it.',
    `While I was in the repo I saw that PR #${number}${descriptor} ${age} and ${situation}.`,
    "If it would save you time, I'm glad to run your own declared checks against it in a clean," +
      ' isolated environment and send you the results privately, with nothing published unless you' +
      ' want it.',
    "No pressure either way, and if you'd rather I didn't, just let me know.",
  ].join(' ');
}

// Move 5. Posted in a thread with an already-engaged maintainer. Safe to send now.
export function issueChoiceOffer() {
  return [
    "I have time to take on one more fix in this repo this week if that's useful to you.",
    "Is there an issue that's been especially annoying or stuck that you'd want me to look at?",
  ].join(' ');
}

// Move 6. Sent to a maintainer who declined our patches, offering verification instead.
// Foreign code: requires recorded PR-scoped consent before the run (boundary gate cleared 2026-07-22).
// Requires the login for the greeting.
export function rejectionHarvestOffer({maintainer} = {}) {
  const login = requireText(maintainer, 'maintainer').replace(/^@+/, '');
  const body = [
    "I completely understand your position on the patches, and I'll respect it.",
    "If it's ever useful in a different way, I'd be glad to independently run your own checks against" +
      ' PRs already sitting in your queue and send you the results privately, so you have a second' +
      ' signal when you are deciding what to review.',
    "Only if that's genuinely helpful to you, and no worries at all if not.",
  ].join(' ');
  return `Hi @${login},\n\n${body}`;
}

// Move 7. A passive affordance for receipt pages and the org README, not an outbound message.
export function affordanceLine({label = NORTHSET_VERIFY_LABEL} = {}) {
  return `Maintainers: want an independent check on any PR? Add the ${label} label,` +
    ' or open a request with this form.';
}

export const OFFER_MESSAGES = Object.freeze({
  self_verify: {gated: false, foreign_code: false, render: (facts) => selfVerifyOffer(facts)},
  post_merge: {gated: false, foreign_code: true, requires: FOREIGN_CODE_CONSENT, render: (facts) => postMergeOffer(facts)},
  issue_choice: {gated: false, foreign_code: false, render: () => issueChoiceOffer()},
  rejection_harvest: {gated: false, foreign_code: true, requires: FOREIGN_CODE_CONSENT, render: (facts) => rejectionHarvestOffer(facts)},
  affordance: {gated: false, foreign_code: false, render: (facts) => affordanceLine(facts)},
});

// Attachable draft: the message text plus the metadata an operator needs before sending.
// The sacrificial-boundary block is cleared; foreign-code offers still require recorded
// PR-scoped consent (see FOREIGN_CODE_CONSENT) before foreign-runner run executes anything.
export function draftOfferMessage(messageKey, facts = {}) {
  const entry = OFFER_MESSAGES[messageKey];
  if (!entry) throw new TypeError(`unknown offer message ${JSON.stringify(messageKey)}`);
  return {
    message_key: messageKey,
    message: entry.render(facts),
    send_gated: entry.gated,
    foreign_code: entry.foreign_code === true,
    requires: entry.foreign_code === true ? entry.requires : null,
  };
}

const SCRIPT_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    const argv = process.argv.slice(2);
    const key = argv.shift();
    const facts = {};
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (!flag?.startsWith('--') || value === undefined) throw new Error(`bad argument near ${flag}`);
      const name = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      facts[name] = /^\d+$/.test(value) ? Number(value) : value;
    }
    if (!OFFER_MESSAGES[key]) {
      throw new Error(`usage: offer-messages.mjs <${Object.keys(OFFER_MESSAGES).join('|')}> [--field value ...]`);
    }
    process.stdout.write(`${draftOfferMessage(key, facts).message}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
