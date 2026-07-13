import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const digest = (char) => `sha256:${char.repeat(64)}`;
const oid = (char) => char.repeat(40);

function subject(id, repo) {
  return {
    schema_version: 1,
    mission_id: id,
    prepared_at: '2026-07-13T12:00:00Z',
    expires_at: '2026-07-13T20:00:00Z',
    repo,
    issue_url: `https://github.com/${repo}/issues/1`,
    base_branch: 'main',
    base_commit: oid('a'),
    commit_oid: oid('b'),
    patch_sha256: digest('c'),
    tested_tree_oid: oid('d'),
    bundle_digest: digest('e'),
    issue_snapshot_sha256: digest('f'),
    policy_snapshot_sha256: digest('1'),
    oracle_sha256: digest('2'),
    pr_title: 'fix: bounded bug',
    pr_body_sha256: digest('3'),
    planned_actions: [
      'push-reviewed-commit', 'publish-reviewed-bundle', 'verify-attestation',
      'open-pr', 'publish-pr-envelope',
    ],
  };
}

test('batch approval is checked once and enforces the three-distinct-repository cap', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(typeof ship.validateApprovedBatch, 'function');
  const subjects = [subject('M-016', 'one/repo'), subject('M-017', 'two/repo')];
  const digestValue = ship.batchManifestDigest(subjects);
  assert.deepEqual(ship.validateApprovedBatch(subjects, digestValue), subjects);
  assert.throws(() => ship.validateApprovedBatch(subjects, digest('9')), /approval/i);
  assert.throws(() => ship.validateApprovedBatch([...subjects, subject('M-018', 'one/repo')], ship.batchManifestDigest([...subjects, subject('M-018', 'one/repo')])), /repository/i);
  const four = [...subjects, subject('M-018', 'three/repo'), subject('M-019', 'four/repo')];
  assert.throws(() => ship.validateApprovedBatch(four, ship.batchManifestDigest(four)), /three/i);
});

test('journal loading treats only ENOENT as empty and rejects corruption', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(typeof ship.loadJournal, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-journal-test-'));
  const file = path.join(root, 'ship.journal.json');
  assert.equal(await ship.loadJournal(file), null);
  await writeFile(file, '{broken');
  await assert.rejects(() => ship.loadJournal(file), /JSON|journal/i);
});

test('journal writes are atomic and bound to the active manifest and bundle', async () => {
  const ship = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-journal-test-'));
  const file = path.join(root, 'ship.journal.json');
  const journal = {approved_manifest: digest('a'), bundle_digest: digest('b')};
  await ship.saveJournal(file, journal);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), journal);
  assert.doesNotThrow(() => ship.assertJournalBinding(journal, digest('a'), digest('b')));
  assert.throws(() => ship.assertJournalBinding(journal, digest('c'), digest('b')), /manifest/i);
});

test('an existing same-named repository must be the intended upstream fork', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(ship.assertForkParent({
    full_name: 'AysajanE/repo', fork: true, parent: {full_name: 'owner/repo'},
  }, 'owner/repo'), true);
  assert.throws(() => ship.assertForkParent({
    full_name: 'AysajanE/repo', fork: false, parent: null,
  }, 'owner/repo'), /not a fork/i);
  assert.throws(() => ship.assertForkParent({
    full_name: 'AysajanE/repo', fork: true, parent: {full_name: 'another/repo'},
  }, 'owner/repo'), /not a fork/i);
});

test('status projection records closed state, CI, merge/head evidence, and the M-015 correction', async () => {
  const ship = await import('./ship.mjs');
  const mission = {
    mission_id: 'M-015', patch_commit: oid('a'),
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/x',
    run_record_bundle_digest: digest('b'),
  };
  const projected = ship.publicationFromPr(mission, {
    number: 9, url: 'https://github.com/owner/repo/pull/9', state: 'CLOSED',
    headRefOid: oid('c'), baseRefName: 'main', createdAt: '2026-07-12T00:00:00Z',
    closedAt: '2026-07-13T00:00:00Z', mergedAt: null, updatedAt: '2026-07-13T00:00:00Z',
    reviewDecision: 'CHANGES_REQUESTED', mergeCommit: null,
    statusCheckRollup: [{status: 'COMPLETED', conclusion: 'FAILURE'}],
  });
  assert.equal(projected.state, 'closed_unmerged');
  assert.equal(projected.ci_state, 'failure');
  assert.equal(projected.review_decision, 'changes_requested');
  assert.equal(projected.head_drift, true);
  assert.match(projected.correction_note, /compile-typescript was run/);
  assert.equal(ship.ciState([{__typename: 'StatusContext', state: 'SUCCESS'}]), 'success');
});
