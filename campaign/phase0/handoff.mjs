import {signedRecordDigest, signRecord, verifySignedRecord} from './integrity.mjs';

const REQUIRED = [
  'shift_id', 'created_at', 'active_prepares', 'expiring_qualifications', 'expiring_ready_packs',
  'pending_boards', 'maintainer_comments', 'upstream_ci_failures', 'sev_events', 'budget_remaining',
  'exception_lane_tasks', 'machine_disk_status',
];

function validatePayload(payload) {
  for (const key of REQUIRED) {
    if (payload?.[key] === undefined) throw new Error(`handoff is missing ${key}`);
  }
  return true;
}

export function createHandoff(payload, outgoingPrivateKey) {
  validatePayload(payload);
  return {outgoing: signRecord({kind: 'shift_handoff', ...payload}, outgoingPrivateKey), incoming_confirmation: null};
}

export function confirmHandoff(handoff, incomingPrivateKey, confirmedAt) {
  if (!handoff?.outgoing || handoff.incoming_confirmation !== null) throw new Error('handoff cannot be confirmed in its current state');
  const confirmation = signRecord({
    kind: 'shift_handoff_confirmation', handoff_sha256: signedRecordDigest(handoff.outgoing), confirmed_at: confirmedAt,
  }, incomingPrivateKey);
  if (confirmation.reviewer_id === handoff.outgoing.reviewer_id) throw new Error('handoff requires distinct outgoing and incoming operators');
  return {...handoff, incoming_confirmation: confirmation};
}

export function verifyHandoff(handoff, roster) {
  validatePayload(handoff?.outgoing);
  const outgoingKey = roster.get(handoff.outgoing.reviewer_id);
  const incomingKey = roster.get(handoff?.incoming_confirmation?.reviewer_id);
  if (!outgoingKey || !incomingKey) throw new Error('handoff signer is not in the reviewer roster');
  if (handoff.outgoing.reviewer_id === handoff.incoming_confirmation.reviewer_id) {
    throw new Error('handoff requires distinct outgoing and incoming operators');
  }
  verifySignedRecord(handoff.outgoing, outgoingKey);
  verifySignedRecord(handoff.incoming_confirmation, incomingKey);
  if (handoff.incoming_confirmation.handoff_sha256 !== signedRecordDigest(handoff.outgoing)) {
    throw new Error('incoming confirmation does not bind the outgoing handoff');
  }
  return true;
}
