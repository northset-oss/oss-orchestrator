export function reviewRequirement({calibration_ordinal, risk_tier, receipt_subject_id}) {
  if (Number.isInteger(calibration_ordinal) && calibration_ordinal >= 1 && calibration_ordinal <= 20) {
    return {minimum_reviewers: 2, reason: 'CALIBRATION'};
  }
  if (risk_tier === 'AMBER') return {minimum_reviewers: 2, reason: 'AMBER'};
  if (risk_tier !== 'GREEN') throw new Error('risk_tier must be GREEN or AMBER');
  if (!/^sha256:[0-9a-f]{2,64}$/i.test(receipt_subject_id ?? '')) throw new Error('receipt_subject_id is invalid');
  const prefix = receipt_subject_id.slice('sha256:'.length).padEnd(4, '0').slice(0, 4);
  const audited = Number.parseInt(prefix, 16) / 0x10000 < 0.05;
  return {minimum_reviewers: audited ? 2 : 1, reason: audited ? 'GREEN_5_PERCENT_AUDIT' : 'GREEN'};
}

export function assertCalibrationState(reviews, {founder_adjudication = null} = {}) {
  if (!Array.isArray(reviews)) throw new Error('reviews must be an array');
  if (reviews.length === 2 && reviews.every((item) => typeof item.ship === 'boolean') &&
      reviews[0].ship !== reviews[1].ship && !founder_adjudication) {
    throw new Error('ship/no-ship disagreement requires founder adjudication before publication');
  }
  const trailing = reviews.slice(-20);
  if (trailing.length === 20) {
    const disagreements = trailing.filter((item) => item.disagreed === true).length;
    if (disagreements / trailing.length > 0.1) throw new Error('trailing review disagreement is >10%; pause and recalibrate');
  }
  return true;
}
