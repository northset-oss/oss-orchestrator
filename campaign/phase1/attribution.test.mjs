import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  assertD8Closed,
  buildAttemptAttribution,
  classifiedAttributionCoverage,
  validateAttemptAttribution,
} from './attribution.mjs';

test('attempt attribution uses only frozen measurement classes and records unavailable values honestly', () => {
  const attribution = buildAttemptAttribution({
    qualification: {duration_ms: 42_000, input_tokens: null, output_tokens: null},
    author: {duration_ms: 180_000, input_tokens: null, output_tokens: null},
    execution: {wall_ms: 250_000, lane_hours: 0.08},
  });

  assert.equal(validateAttemptAttribution(attribution), true);
  assert.deepEqual(Object.keys(attribution.components).sort(), [
    'compute', 'model', 'operator_labor', 'subscription',
  ]);
  assert.equal(attribution.components.model.measurement_class, 'observed_usage');
  assert.equal(attribution.components.model.values.duration_ms, 222_000);
  assert.equal(attribution.components.compute.measurement_class, 'observed_usage');
  assert.equal(attribution.components.subscription.measurement_class, 'unavailable');
  assert.match(attribution.components.subscription.reason, /fixed subscription/i);
  assert.equal(attribution.components.operator_labor.measurement_class, 'unavailable');
});

test('coverage counts complete classification on success and failure attempts', () => {
  const complete = buildAttemptAttribution({execution: {wall_ms: 10_000, lane_hours: 0.01}});
  const records = Array.from({length: 20}, (_, index) => ({
    state: index % 2 ? 'READY' : 'FAILED_AUTHOR',
    ...(index === 19 ? {} : {attribution: complete}),
  }));
  assert.deepEqual(classifiedAttributionCoverage(records), {
    attempts: 20,
    classified_attempts: 19,
    coverage: 0.95,
    passes: true,
  });
});

test('D8 is closed by the frozen numeric resource policy', async () => {
  const protocol = JSON.parse(await readFile(new URL('../phase0/protocol.v1.json', import.meta.url)));
  assert.equal(assertD8Closed(protocol), true);
  assert.throws(() => assertD8Closed({resource_breakers: {...protocol.resource_breakers, max_standard_lane_hours_per_task: null}}), /D8/i);
});
