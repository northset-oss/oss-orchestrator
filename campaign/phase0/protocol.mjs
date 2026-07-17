import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {canonical, sha256} from '../../core.mjs';
import {signRecord, verifySignedRecord} from './integrity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_TOP_LEVEL = [
  'units_of_analysis', 'countable_states', 'failure_taxonomy', 'sev_taxonomy',
  'matured_cohort', 'cost_allocation', 'open_outcome_censoring', 'counting',
  'resource_breakers', 'review_policy', 'social_gates', 'goal_mix', 'amendment_control',
];

export async function loadProtocol(file = path.join(HERE, 'protocol.v1.json')) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function validateProtocol(protocol) {
  if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) throw new Error('protocol must be an object');
  if (protocol.status !== 'frozen' || !/^\d+\.\d+\.\d+$/.test(protocol.version ?? '')) {
    throw new Error('protocol must have a frozen semantic version');
  }
  for (const key of REQUIRED_TOP_LEVEL) {
    if (protocol[key] === undefined || protocol[key] === null) throw new Error(`protocol is missing ${key}`);
  }
  if (!Array.isArray(protocol.units_of_analysis) || protocol.units_of_analysis.length < 4) {
    throw new Error('protocol must freeze units of analysis');
  }
  if (protocol.counting.subject_identity_fields.join('|') !==
      'schema_version|variant|repository_node_id|pr_number|tested_oid|policy_digest|test_mode') {
    throw new Error('protocol has a noncanonical receipt subject identity');
  }
  if (protocol.amendment_control.prospective_only !== true || protocol.amendment_control.no_regrading_prior_data !== true) {
    throw new Error('protocol amendment control must be prospective and forbid regrading');
  }
  return true;
}

export function assertProspectiveAmendment(protocol, amendment) {
  validateProtocol(protocol);
  const decided = Date.parse(amendment?.decided_at ?? '');
  const effective = Date.parse(amendment?.effective_at ?? '');
  if (!Number.isFinite(decided) || !Number.isFinite(effective) || effective <= decided) {
    throw new Error('protocol amendments must be prospective: effective_at must follow decided_at');
  }
  if (!/^\d+\.\d+\.\d+$/.test(amendment.version ?? '') || amendment.version === protocol.version) {
    throw new Error('protocol amendments require a new semantic version');
  }
  return true;
}

export function protocolFreezeRecord(protocol, privateKey) {
  validateProtocol(protocol);
  return signRecord({
    kind: 'campaign_protocol_freeze',
    protocol_id: protocol.protocol_id,
    protocol_version: protocol.version,
    protocol_sha256: sha256(Buffer.from(canonical(protocol), 'utf8')),
    frozen_at: protocol.frozen_at,
  }, privateKey);
}

export function verifyProtocolFreeze(protocol, record, roster) {
  validateProtocol(protocol);
  const expected = sha256(Buffer.from(canonical(protocol), 'utf8'));
  if (record?.protocol_sha256 !== expected || record.protocol_version !== protocol.version ||
      record.protocol_id !== protocol.protocol_id) {
    throw new Error('protocol freeze record has the wrong protocol digest or identity');
  }
  const publicKey = roster.get(record.reviewer_id);
  if (!publicKey) throw new Error('protocol signer is not in the verified roster');
  verifySignedRecord(record, publicKey);
  return true;
}
