export const FIRST_TWENTY_PUBLIC_LIMITS = Object.freeze({
  repositoryOpen: 1,
  ownerRolling7d: 2,
  perHour: 1,
  perDay: 3,
});

const LIMIT_KEYS = Object.freeze([
  'repositoryOpen',
  'ownerRolling7d',
  'perHour',
  'perDay',
]);

export function normalizePublicLimits(value = FIRST_TWENTY_PUBLIC_LIMITS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('public limits must be an object');
  }
  const normalized = {};
  for (const key of LIMIT_KEYS) {
    const limit = Number(value[key]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError(`public limit ${key} must be an integer from 1 through 100`);
    }
    normalized[key] = limit;
  }
  if (normalized.repositoryOpen !== 1) {
    throw new TypeError('public limit repositoryOpen must remain 1');
  }
  return Object.freeze(normalized);
}

export function exceedsPublicLimits(value, ceiling = FIRST_TWENTY_PUBLIC_LIMITS) {
  const limits = normalizePublicLimits(value);
  const maximum = normalizePublicLimits(ceiling);
  return LIMIT_KEYS.some((key) => limits[key] > maximum[key]);
}
