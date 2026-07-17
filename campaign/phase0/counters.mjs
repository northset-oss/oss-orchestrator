import {createHash} from 'node:crypto';

const SUBJECT_KEYS = [
  'schema_version', 'variant', 'repository_node_id', 'pr_number',
  'tested_oid', 'policy_digest', 'test_mode',
];
const COUNTABLE = new Set(['A_SHIPPED_PUBLIC', 'V_DELIVERED_PRIVATE', 'V_PUBLISHED_PUBLIC']);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateSubject(subject) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) throw new Error('receipt subject must be an object');
  if (!Number.isInteger(subject.schema_version) || subject.schema_version < 1) throw new Error('schema_version must be a positive integer');
  if (typeof subject.variant !== 'string' || !subject.variant) throw new Error('variant must be a nonempty string');
  if (typeof subject.repository_node_id !== 'string' || !subject.repository_node_id) throw new Error('repository_node_id must be a nonempty string');
  if (!Number.isInteger(subject.pr_number) || subject.pr_number < 1) throw new Error('pr_number must be a positive integer');
  if (!/^[0-9a-f]{40,64}$/i.test(subject.tested_oid ?? '')) throw new Error('tested_oid must be a 40-64 character hex object id');
  if (!/^sha256:[0-9a-f]{64}$/i.test(subject.policy_digest ?? '')) throw new Error('policy_digest must be a SHA-256 digest');
  if (!['readonly', 'writable_copy'].includes(subject.test_mode)) throw new Error('test_mode must be readonly or writable_copy');
}

export function receiptSubjectId(subject) {
  validateSubject(subject);
  const framed = SUBJECT_KEYS.map((key) => [key, subject[key]]);
  return `sha256:${createHash('sha256').update(canonical(framed), 'utf8').digest('hex')}`;
}

export class CampaignCounter {
  #invocations = new Set();
  #subjects = new Map();

  record(event) {
    if (typeof event?.invocation_id !== 'string' || !event.invocation_id) throw new Error('invocation_id is required');
    const id = receiptSubjectId(event.subject);
    const invocationIncrement = this.#invocations.has(event.invocation_id) ? 0 : 1;
    this.#invocations.add(event.invocation_id);
    const previous = this.#subjects.get(id) ?? null;
    let next = previous;
    let receiptIncrement = 0;
    let bucketMove = false;

    const authorizedAuthored = event.outcome === 'A_SHIPPED_PUBLIC' && event.authorization === 'NORTHSET_AUTHORED';
    const authorizedVerification = ['V_DELIVERED_PRIVATE', 'V_PUBLISHED_PUBLIC'].includes(event.outcome) &&
      ['MAINTAINER_AUTHORIZED', 'ORGANIZATION_AUTHORIZED'].includes(event.authorization);
    if (COUNTABLE.has(event.outcome) && (authorizedAuthored || authorizedVerification)) {
      if (previous === null) {
        next = event.outcome;
        receiptIncrement = 1;
      } else if (previous === 'V_DELIVERED_PRIVATE' && event.outcome === 'V_PUBLISHED_PUBLIC') {
        next = event.outcome;
        bucketMove = true;
      }
    }
    if (next !== null) this.#subjects.set(id, next);
    return {receipt_subject_id: id, invocation_increment: invocationIncrement,
      receipt_increment: receiptIncrement, bucket_move: bucketMove, bucket: next};
  }

  snapshot() {
    const buckets = {A_SHIPPED_PUBLIC: 0, V_DELIVERED_PRIVATE: 0, V_PUBLISHED_PUBLIC: 0};
    for (const bucket of this.#subjects.values()) buckets[bucket] += 1;
    return {invocations: this.#invocations.size, receipt_subjects: this.#subjects.size,
      buckets, total_external_unique: this.#subjects.size};
  }
}
