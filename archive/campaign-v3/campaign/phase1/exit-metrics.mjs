const DAY_MS = 24 * 60 * 60 * 1000;
const FRESHNESS_MS = 48 * 60 * 60 * 1000;

function parseTime(value, name) {
  const parsed = Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function postFix(records, field, fixMs, nowMs) {
  return records.filter((record) => {
    const at = Date.parse(record[field] ?? '');
    return Number.isFinite(at) && at >= fixMs && at <= nowMs;
  });
}

function qualifyingPeriodRun(periods, fixMs, nowMs) {
  const complete = periods.map((period) => ({...period, start: Date.parse(period.start_at), end: Date.parse(period.end_at)}))
    .filter((period) => Number.isFinite(period.start) && Number.isFinite(period.end)
      && period.start >= fixMs && period.end <= nowMs && period.end - period.start === DAY_MS)
    .sort((a, b) => a.start - b.start);
  let current = 0;
  let longest = 0;
  let previousEnd = null;
  for (const period of complete) {
    if (period.A_SHIPPED_PUBLIC >= 10) current = previousEnd === period.start ? current + 1 : 1;
    else current = 0;
    previousEnd = period.end;
    longest = Math.max(longest, current);
  }
  return {complete, longest};
}

function check(id, passed, actual, threshold) {
  return {id, passed: Boolean(passed), actual, threshold};
}

function workspaceModeMetrics(attempts) {
  const profiles = new Map();
  for (const attempt of attempts) {
    const profile = String(attempt.profile ?? '').trim();
    if (!profile) continue;
    const current = profiles.get(profile) ?? {attempts: 0, writable_copy: 0};
    current.attempts += 1;
    if (attempt.workspace_mode === 'writable_copy') current.writable_copy += 1;
    profiles.set(profile, current);
  }
  return Object.fromEntries([...profiles].sort(([left], [right]) => left.localeCompare(right)).map(([profile, value]) => {
    const share = value.writable_copy / value.attempts;
    return [profile, {
      ...value,
      writable_copy_share: share,
      attention: share > 0.10,
      investigate: share > 0.15,
    }];
  }));
}

export function buildExitSnapshot(input) {
  if (!input || typeof input !== 'object') throw new Error('exit input is required');
  const nowMs = parseTime(input.now, 'now');
  const fixMs = parseTime(input.fixes_live_at, 'fixes_live_at');
  if (fixMs > nowMs) throw new Error('fixes_live_at cannot be in the future');
  const periodResult = qualifyingPeriodRun(input.periods ?? [], fixMs, nowMs);
  const attempts = postFix(input.attempts ?? [], 'started_at', fixMs, nowMs)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const trailingAttempts = attempts.slice(-50);
  const firstReady = trailingAttempts.filter((attempt) => attempt.attempt_sequence === 1 && attempt.state === 'READY').length;
  const tasks = postFix(input.tasks ?? [], 'terminal_at', fixMs, nowMs)
    .sort((a, b) => Date.parse(a.terminal_at) - Date.parse(b.terminal_at));
  const trailingTasks = tasks.slice(-30);
  const shippedTrailing = trailingTasks.filter((task) => task.state === 'SHIPPED').length;
  const shippedTasks = tasks.filter((task) => task.state === 'SHIPPED');
  const attemptCounts = shippedTasks.map((task) => task.attempt_count).filter((value) => Number.isInteger(value) && value > 0);
  const thirdAttemptCount = shippedTasks.filter((task) => Number.isInteger(task.attempt_count) && task.attempt_count >= 3).length;
  const prepareDurations = attempts.map((attempt) => attempt.prepare_duration_ms).filter((value) => Number.isFinite(value) && value >= 0);
  const attributed = attempts.filter((attempt) => attempt.attribution_complete === true).length;
  const reviews = postFix(input.reviews ?? [], 'reviewed_at', fixMs, nowMs);
  const signedReviews = reviews.filter((review) => review.signed === true).length;
  const incidents = postFix(input.incidents ?? [], 'occurred_at', fixMs, nowMs);
  const integrityClasses = new Set(['binding', 'claim', 'secret', 'isolation']);
  const integrityIncidents = incidents.filter((incident) => integrityClasses.has(String(incident.incident_class).toLowerCase())).length;
  const sev1 = incidents.filter((incident) => String(incident.severity).toUpperCase().replace('_', '-') === 'SEV-1').length;
  const lake = input.lake ?? {};
  const availableSlotFloor = Math.max(300, (lake.phase1_daily_rate ?? 0) * (lake.p75_lifetime_days ?? 30));
  const lakeSnapshotMs = Date.parse(lake.snapshot_at ?? '');
  const lakeFresh = Number.isFinite(lakeSnapshotMs) && lakeSnapshotMs <= nowMs && nowMs - lakeSnapshotMs <= FRESHNESS_MS;
  const medianThreshold = input.fixes_demonstrably_landed ? 1.5 : 2;
  const firstRate = rate(firstReady, trailingAttempts.length);
  const shippedRate = rate(shippedTrailing, trailingTasks.length);
  const thirdRate = rate(thirdAttemptCount, shippedTasks.length);
  const attributionRate = rate(attributed, attempts.length);
  const signedRate = rate(signedReviews, reviews.length);
  const pilotProfiles = input.pilot_profiles ?? {};

  const metrics = {
    fixes_live_at: new Date(fixMs).toISOString(),
    complete_post_fix_24h_periods: periodResult.complete.length,
    consecutive_qualifying_24h_periods: periodResult.longest,
    first_attempt_ready: {sample_size: trailingAttempts.length, ready: firstReady, rate: firstRate},
    task_to_shipped: {sample_size: trailingTasks.length, shipped: shippedTrailing, rate: shippedRate},
    median_attempts_per_receipt: median(attemptCounts),
    median_attempts_threshold: medianThreshold,
    third_attempt_rate: thirdRate,
    p95_prepare_ms: p95(prepareDurations),
    workspace_modes: workspaceModeMetrics(attempts),
    cost_attribution: {sample_size: attempts.length, complete: attributed, rate: attributionRate},
    d8_closed: input.d8_closed === true,
    integrity_incidents: integrityIncidents,
    sev1_incidents: sev1,
    signed_reviews: {sample_size: reviews.length, signed: signedReviews, rate: signedRate, shipped_receipts: shippedTasks.length},
    lake: {
      fresh_issues: lake.fresh_issues ?? 0,
      fresh_repositories: lake.fresh_repositories ?? 0,
      available_slots: lake.available_slots ?? 0,
      owner_concentration_in_policy: lake.owner_concentration_in_policy === true,
      snapshot_fresh: lakeFresh,
    },
    available_slot_floor: availableSlotFloor,
    pilots: {
      python: pilotProfiles.python?.production_ready === true,
      go: pilotProfiles.go?.production_ready === true,
    },
    batch_tests_passed: input.batch_tests_passed === true,
    restore_test_passed: input.restore_test_passed === true,
  };

  const checks = [
    check('three_24h_periods', periodResult.longest >= 3, periodResult.longest, 3),
    check('first_attempt_ready', trailingAttempts.length === 50 && firstRate >= 0.5, metrics.first_attempt_ready, '>=0.50 over trailing 50'),
    check('task_to_shipped', trailingTasks.length === 30 && shippedRate >= 0.7, metrics.task_to_shipped, '>=0.70 over trailing 30'),
    check('median_attempts_per_receipt', attemptCounts.length > 0 && metrics.median_attempts_per_receipt <= medianThreshold, metrics.median_attempts_per_receipt, `<=${medianThreshold}`),
    check('third_attempt_rate', thirdRate !== null && thirdRate <= 0.05, thirdRate, '<=0.05'),
    check('p95_prepare', prepareDurations.length > 0 && metrics.p95_prepare_ms <= 45 * 60 * 1000, metrics.p95_prepare_ms, '<=2700000ms'),
    check('cost_attribution', attempts.length > 0 && attributionRate >= 0.95, metrics.cost_attribution, '>=0.95'),
    check('d8_closed', metrics.d8_closed, metrics.d8_closed, true),
    check('integrity_incidents', integrityIncidents === 0, integrityIncidents, 0),
    check('sev1', sev1 === 0, sev1, 0),
    check('signed_reviews', shippedTasks.length > 0 && reviews.length >= shippedTasks.length && signedRate === 1, metrics.signed_reviews, '100% and >= shipped receipts'),
    check('fresh_issues', metrics.lake.fresh_issues >= 1000, metrics.lake.fresh_issues, '>=1000'),
    check('fresh_repositories', metrics.lake.fresh_repositories >= 400, metrics.lake.fresh_repositories, '>=400'),
    check('available_slots', metrics.lake.available_slots >= availableSlotFloor, metrics.lake.available_slots, `>=${availableSlotFloor}`),
    check('owner_concentration_policy', metrics.lake.owner_concentration_in_policy, metrics.lake.owner_concentration_in_policy, true),
    check('lake_snapshot_freshness', metrics.lake.snapshot_fresh, metrics.lake.snapshot_fresh, '<=48h'),
    check('python_profile_pilot', metrics.pilots.python, metrics.pilots.python, true),
    check('go_profile_pilot', metrics.pilots.go, metrics.pilots.go, true),
    check('batch_tests', metrics.batch_tests_passed, metrics.batch_tests_passed, true),
    check('restore_test', metrics.restore_test_passed, metrics.restore_test_passed, true),
  ];
  return {schema_version: 1, phase: 'Phase 1', status: checks.every((item) => item.passed) ? 'PASS' : 'HOLD', metrics, checks};
}
