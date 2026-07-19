const PROFILES = new Set(['python', 'go']);
const KINDS = new Set(['DRY_PREPARE', 'SHIPPED', 'SUPPLY_SNAPSHOT', 'INTEGRITY_INCIDENT']);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function nonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function nonblank(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('pilot event must be an object');
  const normalized = structuredClone(event);
  normalized.event_id = nonblank(normalized.event_id, 'event_id');
  if (!PROFILES.has(normalized.profile)) throw new Error('profile must be python or go');
  if (!KINDS.has(normalized.kind)) throw new Error(`unsupported pilot event kind ${JSON.stringify(normalized.kind)}`);
  normalized.occurred_at = timestamp(normalized.occurred_at, 'occurred_at');

  if (normalized.kind === 'DRY_PREPARE') {
    nonblank(normalized.repo_node_id, 'repo_node_id');
    nonblank(normalized.build_config, 'build_config');
    nonblank(normalized.state, 'state');
    if (typeof normalized.full_prepare !== 'boolean') throw new Error('full_prepare must be boolean');
    if (!Number.isInteger(normalized.publication_actions) || normalized.publication_actions < 0) {
      throw new Error('publication_actions must be a non-negative integer');
    }
    nonnegative(normalized.lane_hours, 'lane_hours');
  } else if (normalized.kind === 'SHIPPED') {
    if (!/^sha256:[0-9a-f]{64}$/i.test(normalized.receipt_subject_id ?? '')) throw new Error('receipt_subject_id must be sha256');
    nonnegative(normalized.lane_hours, 'lane_hours');
  } else if (normalized.kind === 'SUPPLY_SNAPSHOT') {
    if (!Number.isInteger(normalized.eligible_candidates) || normalized.eligible_candidates < 0) {
      throw new Error('eligible_candidates must be a non-negative integer');
    }
    nonblank(normalized.source, 'source');
  } else {
    nonblank(normalized.incident_class, 'incident_class');
  }
  return normalized;
}

export function createPilotLedger() {
  return {schema_version: 1, events: []};
}

export function addPilotEvent(ledger, event) {
  if (ledger?.schema_version !== 1 || !Array.isArray(ledger.events)) throw new Error('invalid pilot ledger');
  const normalized = normalizeEvent(event);
  const previous = ledger.events.find((item) => item.event_id === normalized.event_id);
  if (previous) {
    if (canonical(previous) !== canonical(normalized)) throw new Error(`event_id ${normalized.event_id} already has different bytes`);
    return ledger;
  }
  return {...structuredClone(ledger), events: [...ledger.events.map((item) => structuredClone(item)), normalized]};
}

function summarizeProfile(events, profile) {
  const profileEvents = events.filter((event) => event.profile === profile);
  const fullDry = profileEvents.filter((event) => event.kind === 'DRY_PREPARE' && event.full_prepare && event.publication_actions === 0);
  const successfulDry = fullDry.filter((event) => event.state === 'READY');
  const shippedEvents = profileEvents.filter((event) => event.kind === 'SHIPPED');
  const shipped = new Set(shippedEvents.map((event) => event.receipt_subject_id));
  const incidents = profileEvents.filter((event) => event.kind === 'INTEGRITY_INCIDENT');
  const supply = profileEvents.filter((event) => event.kind === 'SUPPLY_SNAPSHOT')
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)).at(-1) ?? null;
  const readyDry = successfulDry.length;
  const laneHours = [...fullDry, ...shippedEvents].reduce((total, event) => total + event.lane_hours, 0);
  const dryYield = fullDry.length ? readyDry / fullDry.length : null;
  const orderingScore = supply && dryYield !== null && laneHours > 0
    ? (supply.eligible_candidates * dryYield) / laneHours
    : null;
  const thresholds = {
    dry_prepares: successfulDry.length,
    repositories: new Set(successfulDry.map((event) => event.repo_node_id)).size,
    build_configs: new Set(successfulDry.map((event) => event.build_config)).size,
    shipped: shipped.size,
    integrity_incidents: incidents.length,
  };
  return {
    profile,
    ...thresholds,
    total_full_dry_prepares: fullDry.length,
    ready_dry_prepares: readyDry,
    dry_prepare_yield: dryYield,
    lane_hours: laneHours,
    eligible_supply: supply?.eligible_candidates ?? null,
    supply_snapshot_at: supply?.occurred_at ?? null,
    supply_adjusted_yield_per_lane_hour: orderingScore,
    thresholds,
    production_ready: thresholds.dry_prepares >= 20
      && thresholds.repositories >= 10
      && thresholds.build_configs >= 3
      && thresholds.shipped >= 5
      && thresholds.integrity_incidents === 0,
  };
}

export function pilotSnapshot(ledger) {
  if (ledger?.schema_version !== 1 || !Array.isArray(ledger.events)) throw new Error('invalid pilot ledger');
  const profiles = Object.fromEntries([...PROFILES].map((profile) => [profile, summarizeProfile(ledger.events, profile)]));
  const productionOrder = Object.values(profiles)
    .filter((profile) => profile.supply_adjusted_yield_per_lane_hour !== null)
    .sort((a, b) => b.supply_adjusted_yield_per_lane_hour - a.supply_adjusted_yield_per_lane_hour || a.profile.localeCompare(b.profile))
    .map((profile) => profile.profile);
  return {schema_version: 1, profiles, production_order: productionOrder};
}
