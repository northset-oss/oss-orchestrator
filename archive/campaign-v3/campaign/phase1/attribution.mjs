const MEASUREMENT_CLASSES = new Set([
  'observed_usage',
  'allocated_subscription_cost',
  'allocated_internal_labor_cost',
  'unavailable',
]);

const REQUIRED_COMPONENTS = Object.freeze([
  'model',
  'compute',
  'subscription',
  'operator_labor',
]);

function finite(value) {
  return Number.isFinite(value) && value >= 0;
}

function unavailable(reason) {
  return {measurement_class: 'unavailable', reason};
}

function observed(values) {
  const present = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined));
  return Object.keys(present).length
    ? {measurement_class: 'observed_usage', values: present}
    : unavailable('usage was not measured for this attempt');
}

export function buildAttemptAttribution({
  qualification = {},
  author = {},
  execution = {},
  subscription = null,
  operatorLabor = null,
} = {}) {
  const durations = [qualification.duration_ms, author.duration_ms].filter(finite);
  const modelDuration = durations.length ? durations.reduce((sum, value) => sum + value, 0) : null;
  const tokenFields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens'];
  const tokenValues = {};
  for (const field of tokenFields) {
    const values = [qualification[field], author[field]].filter(finite);
    if (values.length) tokenValues[field] = values.reduce((sum, value) => sum + value, 0);
  }

  return {
    schema_version: 1,
    components: {
      model: observed({duration_ms: modelDuration, ...tokenValues}),
      compute: observed({wall_ms: finite(execution.wall_ms) ? execution.wall_ms : null,
        lane_hours: finite(execution.lane_hours) ? execution.lane_hours : null}),
      subscription: subscription ?? unavailable('fixed subscription cost is not allocated per attempt'),
      operator_labor: operatorLabor ?? unavailable('operator labor was not recorded for this attempt'),
    },
  };
}

export function validateAttemptAttribution(attribution) {
  if (attribution?.schema_version !== 1 || !attribution.components || typeof attribution.components !== 'object') {
    throw new Error('attempt attribution schema_version 1 and components are required');
  }
  for (const name of REQUIRED_COMPONENTS) {
    const component = attribution.components[name];
    if (!component || !MEASUREMENT_CLASSES.has(component.measurement_class)) {
      throw new Error(`attempt attribution ${name} has an invalid measurement class`);
    }
    if (component.measurement_class === 'unavailable') {
      if (typeof component.reason !== 'string' || !component.reason.trim()) {
        throw new Error(`attempt attribution ${name} unavailable class requires a reason`);
      }
      continue;
    }
    if (component.measurement_class === 'observed_usage') {
      if (!component.values || !Object.values(component.values).some(finite)) {
        throw new Error(`attempt attribution ${name} observed usage requires a measured value`);
      }
      continue;
    }
    if (!finite(component.amount) || typeof component.currency !== 'string' || !component.currency.trim()) {
      throw new Error(`attempt attribution ${name} allocated cost requires amount and currency`);
    }
  }
  return true;
}

export function classifiedAttributionCoverage(records, threshold = 0.95) {
  if (!Array.isArray(records)) throw new Error('attempt records must be an array');
  let classified = 0;
  for (const record of records) {
    try {
      validateAttemptAttribution(record?.attribution);
      classified += 1;
    } catch {}
  }
  const attempts = records.length;
  const coverage = attempts ? classified / attempts : 0;
  return {attempts, classified_attempts: classified, coverage, passes: attempts > 0 && coverage >= threshold};
}

export function assertD8Closed(protocol) {
  const policy = protocol?.resource_breakers;
  const numeric = [
    'max_model_minutes_per_attempt',
    'max_standard_attempts_per_task',
    'max_standard_lane_hours_per_task',
    'receipt_lane_hour_flag_above',
    'exception_task_share',
    'max_active_exceptions',
    'max_exception_lane_hours',
  ];
  if (!policy || numeric.some((field) => !finite(policy[field])) ||
      policy.provider_throttle_requires_founder_review !== true || policy.auto_resume !== false) {
    throw new Error('D8 resource breakers are not numerically closed');
  }
  return true;
}
