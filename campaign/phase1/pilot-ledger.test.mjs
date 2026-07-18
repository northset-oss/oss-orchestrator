import assert from 'node:assert/strict';
import test from 'node:test';

import {addPilotEvent, createPilotLedger, pilotSnapshot} from './pilot-ledger.mjs';

function completedPilot(profile, {laneHours, supply}) {
  let ledger = createPilotLedger();
  for (let index = 0; index < 20; index += 1) {
    ledger = addPilotEvent(ledger, {
      event_id: `${profile}-dry-${index}`,
      profile,
      kind: 'DRY_PREPARE',
      occurred_at: `2026-07-18T${String(index).padStart(2, '0')}:00:00Z`,
      repo_node_id: `${profile}-repo-${index % 10}`,
      build_config: `${profile}-config-${index % 3}`,
      full_prepare: true,
      publication_actions: 0,
      state: 'READY',
      lane_hours: laneHours,
    });
  }
  for (let index = 0; index < 5; index += 1) {
    ledger = addPilotEvent(ledger, {
      event_id: `${profile}-ship-${index}`,
      profile,
      kind: 'SHIPPED',
      occurred_at: `2026-07-19T0${index}:00:00Z`,
      receipt_subject_id: `sha256:${String(index).repeat(64).slice(0, 64)}`,
      lane_hours: laneHours,
    });
  }
  return addPilotEvent(ledger, {
    event_id: `${profile}-supply`,
    profile,
    kind: 'SUPPLY_SNAPSHOT',
    occurred_at: '2026-07-19T06:00:00Z',
    eligible_candidates: supply,
    source: 'candidate_lake.sqlite',
  });
}

test('Python and Go production readiness requires the exact pilot evidence floor', () => {
  let ledger = createPilotLedger();
  for (const event of completedPilot('python', {laneHours: 1, supply: 100}).events) ledger = addPilotEvent(ledger, event);
  for (const event of completedPilot('go', {laneHours: 0.25, supply: 60}).events) ledger = addPilotEvent(ledger, event);

  const snapshot = pilotSnapshot(ledger);
  assert.equal(snapshot.profiles.python.production_ready, true);
  assert.equal(snapshot.profiles.go.production_ready, true);
  assert.deepEqual(snapshot.profiles.python.thresholds, {
    dry_prepares: 20,
    repositories: 10,
    build_configs: 3,
    shipped: 5,
    integrity_incidents: 0,
  });
  assert.deepEqual(snapshot.production_order, ['go', 'python']);
});

test('non-full or public dry runs do not count and any integrity incident blocks the profile', () => {
  let ledger = completedPilot('python', {laneHours: 0.5, supply: 100});
  ledger = addPilotEvent(ledger, {
    event_id: 'python-incident-1',
    profile: 'python',
    kind: 'INTEGRITY_INCIDENT',
    occurred_at: '2026-07-19T07:00:00Z',
    incident_class: 'isolation',
  });
  ledger = addPilotEvent(ledger, {
    event_id: 'python-public-dry',
    profile: 'python',
    kind: 'DRY_PREPARE',
    occurred_at: '2026-07-19T08:00:00Z',
    repo_node_id: 'python-extra',
    build_config: 'python-extra',
    full_prepare: true,
    publication_actions: 1,
    state: 'READY',
    lane_hours: 0.5,
  });
  ledger = addPilotEvent(ledger, {
    event_id: 'python-failed-dry',
    profile: 'python',
    kind: 'DRY_PREPARE',
    occurred_at: '2026-07-19T09:00:00Z',
    repo_node_id: 'python-failed',
    build_config: 'python-failed',
    full_prepare: true,
    publication_actions: 0,
    state: 'FAILED_ORACLE',
    lane_hours: 0.5,
  });

  const profile = pilotSnapshot(ledger).profiles.python;
  assert.equal(profile.dry_prepares, 20);
  assert.equal(profile.total_full_dry_prepares, 21);
  assert.equal(profile.integrity_incidents, 1);
  assert.equal(profile.production_ready, false);
});

test('pilot ledger is idempotent by event id', () => {
  const event = completedPilot('go', {laneHours: 0.25, supply: 60}).events[0];
  const once = addPilotEvent(createPilotLedger(), event);
  assert.deepEqual(addPilotEvent(once, event), once);
  assert.throws(() => addPilotEvent(once, {...event, lane_hours: 9}), /event_id/i);
});
