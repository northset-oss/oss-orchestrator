export const PROMOTION_FREE_DISCLOSURE =
  'AI assistance was used through tooling operated by Northset. I reviewed the final diff and test results and take personal responsibility for this contribution.';

export const CONSENT_SCOPES = Object.freeze([
  'contribution_invitation',
  'verification_execution_consent',
  'receipt_publication_consent',
  'marketing_reference_consent',
]);

const LEGACY_RECEIPT_BLOCK = /(?:\n---\n)?<!-- northset-receipt:[^:\n]+:start -->[\s\S]*?<!-- northset-receipt:[^:\n]+:end -->/giu;
const LEGACY_DISCLOSURE =
  /(?:\n+)?AI-assisted and reviewed by Northset; I take responsibility for this submission\.\s*$/iu;
const EXTERNAL_ENDORSEMENT =
  /\b(?:upstream(?:\s+CI)?|CI|continuous integration|maintainers?|reviewers?|the project|project checks?)\b[^.\n]{0,100}\b(?:agreed|disagreed|validated|endorsed|confirmed|ratified|approved)\b/iu;
const REVERSE_EXTERNAL_ENDORSEMENT =
  /\b(?:agreed|disagreed|validated|endorsed|confirmed|ratified|approved)\b[^.\n]{0,100}\b(?:by|with)\s+(?:upstream(?:\s+CI)?|CI|continuous integration|maintainers?|reviewers?|the project|project checks?)\b/iu;

function assertContributionOnlyBody(body, manifest) {
  let contributionBody = body.replace(PROMOTION_FREE_DISCLOSURE, '');
  if (manifest.receipt_visibility === 'public_opt_in') {
    contributionBody = contributionBody.replace(`Technical receipt: ${manifest.receipt_url}`, '');
  }
  const evidence = manifest.evidence_asset;
  if (evidence) {
    const expectedEvidenceUrl = `https://raw.githubusercontent.com/${evidence.repository}/${evidence.commit_oid}/${evidence.path}`;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(String(evidence.repository ?? '')) &&
        /^[a-f0-9]{40}$/u.test(String(evidence.commit_oid ?? '')) &&
        typeof evidence.path === 'string' && evidence.path.length > 0 &&
        !evidence.path.startsWith('/') && !evidence.path.split('/').includes('..') &&
        evidence.url === expectedEvidenceUrl) {
      contributionBody = contributionBody.replace(evidence.url, '');
    }
  }
  const forbidden = [
    /\bnorthset\b/iu,
    /\b(?:public|proof-of-pass|technical transparency|our)\s+(?:ledger|receipt)\b/iu,
    /\b(?:verification|receipt)\s+(?:product|service|offer|request|program)\b/iu,
    /\b(?:request|offer)\s+(?:a\s+)?(?:verification(?:\s+run)?|run|receipt)\b/iu,
    /\b(?:maintainers?|projects?)\s+can\s+(?:request|install)\b/iu,
    /\b(?:sample|demo)\s+receipt\b/iu,
    /\bpre-?filled\s+(?:email|request)\b/iu,
    /\b(?:learn more|contact us|email us|get started|sign up|install Northset)\b/iu,
    /\bmaintain\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\?/iu,
    EXTERNAL_ENDORSEMENT,
    REVERSE_EXTERNAL_ENDORSEMENT,
  ];
  if (forbidden.some((pattern) => pattern.test(contributionBody))) {
    throw new Error('PR body must remain contribution-only without product, CTA, or endorsement claims');
  }
}

function consentValue(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value : {status: value};
  if (Object.keys(input).some((key) =>
    !['status', 'evidence', 'granted_at', 'granted_by'].includes(key))) {
    throw new Error('consent scope contains an unsupported field');
  }
  const status = ['granted', 'absent', 'not_applicable'].includes(input.status)
    ? input.status : null;
  if (!status) throw new Error('consent scope status must be granted, absent, or not_applicable');
  const result = {
    status,
    evidence: input.evidence ?? null,
    granted_at: input.granted_at ?? null,
    granted_by: input.granted_by ?? null,
  };
  if (status === 'granted') {
    if (!result.evidence || !['public_url', 'private_digest'].includes(result.evidence.kind)) {
      throw new Error('granted consent scope requires public_url or private_digest evidence');
    }
    if (Object.keys(result.evidence).some((key) => !['kind', 'value'].includes(key))) {
      throw new Error('consent evidence contains an unsupported field');
    }
    if (result.evidence.kind === 'public_url' &&
        !/^https?:\/\/[^\s]+$/u.test(String(result.evidence.value ?? ''))) {
      throw new Error('public_url consent evidence must be an HTTP URL');
    }
    if (result.evidence.kind === 'private_digest' &&
        !/^sha256:[a-f0-9]{64}$/u.test(String(result.evidence.value ?? ''))) {
      throw new Error('private_digest consent evidence must be sha256');
    }
    if (!Number.isFinite(Date.parse(result.granted_at)) ||
        typeof result.granted_by !== 'string' || !result.granted_by.trim()) {
      throw new Error('granted consent scope requires granted_at and granted_by');
    }
  } else if (result.evidence !== null || result.granted_at !== null || result.granted_by !== null) {
    throw new Error('non-granted consent scope must not carry evidence');
  }
  return result;
}

export function normalizeConsentScopes(input = {}, {missionId} = {}) {
  if (input?.scopes && Object.keys(input).some((key) =>
    !['schema_version', 'mission_id', 'scopes'].includes(key))) {
    throw new Error('consent_scopes contains an unsupported field');
  }
  const supplied = input?.scopes ?? input;
  if (Object.keys(supplied).some((key) => !CONSENT_SCOPES.includes(key))) {
    throw new Error('consent_scopes contains an unsupported scope');
  }
  const scopes = {};
  for (const name of CONSENT_SCOPES) scopes[name] = consentValue(supplied[name] ?? {status: 'absent'});
  return {schema_version: 2, mission_id: missionId, scopes};
}

export function promotionFreePrBody(body, checks, {receiptUrl = null} = {}) {
  const commands = [...new Set((checks ?? []).map((item) => String(item).trim()).filter(Boolean))];
  if (!commands.length) throw new Error('promotion-free PR text requires exact checks');
  let base = String(body ?? '')
    .replace(LEGACY_RECEIPT_BLOCK, '')
    .replace(LEGACY_DISCLOSURE, '')
    .replace(new RegExp(`(?:\\n+)?${PROMOTION_FREE_DISCLOSURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*$`, 'u'), '')
    .replaceAll('{{MISSION_ID}}', '')
    .replaceAll('{{RECEIPT_URL}}', '')
    .trimEnd();
  const footer = [
    PROMOTION_FREE_DISCLOSURE,
    '',
    'Checks:',
    ...commands.map((command) => `- \`${command.replaceAll('`', '\\`')}\` — passed`),
    ...(receiptUrl ? ['', `Technical receipt: ${receiptUrl}`] : []),
  ].join('\n');
  base = `${base}\n\n${footer}`.trim();
  return `${base}\n`;
}

export function assertPublicationManifest(manifest, {allowLegacySubmitted = false} = {}) {
  if (allowLegacySubmitted && !manifest.receipt_visibility && !manifest.consent_scopes) return true;
  const visibility = manifest.receipt_visibility;
  if (!['private_internal', 'public_opt_in'].includes(visibility)) {
    throw new Error('receipt_visibility must be private_internal or public_opt_in');
  }
  const consent = normalizeConsentScopes(manifest.consent_scopes, {missionId: manifest.mission_id});
  if (manifest.consent_scopes?.schema_version !== 2 ||
      manifest.consent_scopes?.mission_id !== manifest.mission_id) {
    throw new Error('consent_scopes must bind schema_version 2 and the exact mission_id');
  }
  const scopes = consent.scopes;
  if (visibility === 'private_internal') {
    if (manifest.receipt_url !== null) throw new Error('private_internal receipt_url must be null');
    if (scopes.receipt_publication_consent.status === 'granted') {
      throw new Error('private_internal receipt must not claim publication consent');
    }
    if ((manifest.planned_actions ?? []).includes('publish-proof')) {
      throw new Error('private_internal receipt must not plan public proof publication');
    }
  } else {
    if (scopes.receipt_publication_consent.status !== 'granted') {
      throw new Error('public receipt requires explicit receipt_publication_consent');
    }
    if (!/^https:\/\/[^\s]+$/u.test(String(manifest.receipt_url ?? ''))) {
      throw new Error('public receipt requires an HTTPS receipt_url');
    }
    if (!(manifest.planned_actions ?? []).includes('publish-proof')) {
      throw new Error('public receipt must bind publish-proof in planned_actions');
    }
  }
  if ((manifest.planned_actions ?? []).some((action) => /marketing|repository-page|case-study/iu.test(action)) &&
      scopes.marketing_reference_consent.status !== 'granted') {
    throw new Error('marketing action requires explicit marketing_reference_consent');
  }

  const body = String(manifest.pr_body ?? '');
  if (!body.includes(PROMOTION_FREE_DISCLOSURE)) {
    throw new Error('PR body is missing the exact promotion-free disclosure');
  }
  const checks = [...new Set((manifest.checks ?? []).map((item) => String(item).trim()).filter(Boolean))];
  if (!checks.length || checks.some((command) =>
    !body.includes(`- \`${command.replaceAll('`', '\\`')}\` — passed`))) {
    throw new Error('PR body must list every exact declared check as passed');
  }
  const forbidden = [
    /<!--\s*northset-receipt:/iu,
    /reviewed by Northset/iu,
    /checkable (?:in .* )?without trusting us/iu,
    /maintain [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\?/iu,
    /mailto:|oss@northset\.ai/iu,
    /northset-verify/iu,
    /upstream CI agreed/iu,
    /ledger root/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(body))) {
    throw new Error('PR body contains legacy promotional or endorsement language');
  }
  assertContributionOnlyBody(body, manifest);
  if (visibility === 'private_internal') {
    if (/https?:\/\/[^\s)]+(?:receipt|northset-oss)/iu.test(body) ||
        /\bM-[1-9][0-9]*\b/u.test(body)) {
      throw new Error('private_internal PR body must not expose a receipt or mission number');
    }
  } else {
    const receiptOccurrences = body.split(manifest.receipt_url).length - 1;
    if (receiptOccurrences !== 1 ||
        /https?:\/\/[^\s)>]*(?:northset-oss|verification-pilot)[^\s)>]*/iu.test(
          body.replace(manifest.receipt_url, ''),
        )) {
      throw new Error('public_opt_in PR body must contain only the approved public receipt');
    }
  }
  return true;
}
