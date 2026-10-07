// Shared by the API, chain adapters and the bundled editor validation rules.
// Pure: no chain calls or writes may precede this validation.
function validateCampaignSchedule(draft, nowMs = Date.now(), defaultDelaySeconds = 30) {
  const parse = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
    const seconds = Math.floor(Date.parse(value) / 1000);
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(`${name} is invalid`);
    return seconds;
  };
  const nowSeconds = Math.floor(nowMs / 1000);
  const startsAt = draft.startsAt === undefined || draft.startsAt === null || draft.startsAt === ''
    ? nowSeconds + defaultDelaySeconds : parse(draft.startsAt, 'Start time');
  if (startsAt <= nowSeconds) throw new Error('Start time must be in the future');
  const endsAt = draft.unlimited === true ? 0 : parse(draft.endsAt, 'End time');
  if (draft.unlimited !== true && endsAt <= startsAt) throw new Error('End time must be after start time');
  return { startsAt, endsAt };
}
module.exports = { validateCampaignSchedule };
