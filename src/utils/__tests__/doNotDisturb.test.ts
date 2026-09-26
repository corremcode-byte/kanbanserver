import { isDoNotDisturbActive, mergeDoNotDisturbUpdate, isValidTimeZone, MAX_PAUSE_MS } from '../doNotDisturb';

// 2026-09-26 is a Saturday. 12:00 UTC = 17:30 in Asia/Kolkata (UTC+5:30).
const SAT_NOON_UTC = new Date('2026-09-26T12:00:00Z');

describe('isDoNotDisturbActive', () => {
  it('is off with no settings', () => {
    expect(isDoNotDisturbActive(undefined, SAT_NOON_UTC)).toBe(false);
    expect(isDoNotDisturbActive(null, SAT_NOON_UTC)).toBe(false);
    expect(isDoNotDisturbActive({}, SAT_NOON_UTC)).toBe(false);
  });

  it('is on while paused and off once the pause has passed', () => {
    const later = new Date(SAT_NOON_UTC.getTime() + 60_000);
    const earlier = new Date(SAT_NOON_UTC.getTime() - 60_000);
    expect(isDoNotDisturbActive({ pausedUntil: later }, SAT_NOON_UTC)).toBe(true);
    expect(isDoNotDisturbActive({ pausedUntil: later.toISOString() }, SAT_NOON_UTC)).toBe(true);
    expect(isDoNotDisturbActive({ pausedUntil: earlier }, SAT_NOON_UTC)).toBe(false);
    expect(isDoNotDisturbActive({ pausedUntil: 'not a date' }, SAT_NOON_UTC)).toBe(false);
  });

  it('honours days off in the user time zone', () => {
    // Saturday in UTC and in Kolkata
    expect(isDoNotDisturbActive({ daysOff: [6], timezone: 'UTC' }, SAT_NOON_UTC)).toBe(true);
    expect(isDoNotDisturbActive({ daysOff: [0], timezone: 'UTC' }, SAT_NOON_UTC)).toBe(false);
    // 23:00 UTC Saturday is already Sunday 04:30 in Kolkata
    const satLateUtc = new Date('2026-09-26T23:00:00Z');
    expect(isDoNotDisturbActive({ daysOff: [0], timezone: 'Asia/Kolkata' }, satLateUtc)).toBe(true);
    expect(isDoNotDisturbActive({ daysOff: [0], timezone: 'UTC' }, satLateUtc)).toBe(false);
  });

  it('handles an overnight schedule (17:00–09:00) in the user time zone', () => {
    const dnd = { scheduleEnabled: true, scheduleStart: '17:00', scheduleEnd: '09:00', timezone: 'Asia/Kolkata' };
    expect(isDoNotDisturbActive(dnd, SAT_NOON_UTC)).toBe(true);                               // 17:30 IST
    expect(isDoNotDisturbActive(dnd, new Date('2026-09-26T02:00:00Z'))).toBe(true);           // 07:30 IST
    expect(isDoNotDisturbActive(dnd, new Date('2026-09-26T05:00:00Z'))).toBe(false);          // 10:30 IST
    expect(isDoNotDisturbActive({ ...dnd, timezone: 'UTC' }, SAT_NOON_UTC)).toBe(false);      // 12:00 UTC
  });

  it('handles a same-day schedule and treats start == end as empty', () => {
    const lunch = { scheduleEnabled: true, scheduleStart: '11:30', scheduleEnd: '12:30', timezone: 'UTC' };
    expect(isDoNotDisturbActive(lunch, SAT_NOON_UTC)).toBe(true);
    expect(isDoNotDisturbActive({ ...lunch, scheduleEnd: '12:00' }, SAT_NOON_UTC)).toBe(false); // end is exclusive
    expect(isDoNotDisturbActive({ ...lunch, scheduleStart: '12:00', scheduleEnd: '12:00' }, SAT_NOON_UTC)).toBe(false);
  });

  it('ignores the schedule when it is disabled or malformed', () => {
    expect(isDoNotDisturbActive({ scheduleEnabled: false, scheduleStart: '00:00', scheduleEnd: '23:59' }, SAT_NOON_UTC)).toBe(false);
    expect(isDoNotDisturbActive({ scheduleEnabled: true, scheduleStart: '25:00', scheduleEnd: '09:00' }, SAT_NOON_UTC)).toBe(false);
  });

  it('falls back to UTC for an invalid time zone', () => {
    expect(isDoNotDisturbActive({ daysOff: [6], timezone: 'Not/AZone' }, SAT_NOON_UTC)).toBe(true);
  });
});

describe('mergeDoNotDisturbUpdate', () => {
  const now = SAT_NOON_UTC;

  it('fills defaults and merges a partial update', () => {
    const r = mergeDoNotDisturbUpdate({ scheduleEnabled: true }, undefined, now);
    expect(r).toEqual({ value: { pausedUntil: null, scheduleEnabled: true, scheduleStart: '17:00', scheduleEnd: '09:00', daysOff: [], timezone: 'UTC' } });
  });

  it('keeps existing values not in the update', () => {
    const r = mergeDoNotDisturbUpdate({ daysOff: [0, 6, 6] }, { scheduleEnabled: true, scheduleStart: '18:00', scheduleEnd: '08:00', timezone: 'Asia/Kolkata' }, now);
    expect(r).toEqual({ value: expect.objectContaining({ scheduleEnabled: true, scheduleStart: '18:00', daysOff: [0, 6], timezone: 'Asia/Kolkata' }) });
  });

  it('sets and clears a pause; a past time clears it', () => {
    const until = new Date(now.getTime() + 3600_000).toISOString();
    const set = mergeDoNotDisturbUpdate({ pausedUntil: until }, undefined, now);
    expect('value' in set && (set.value.pausedUntil as Date).toISOString()).toBe(until);
    expect(mergeDoNotDisturbUpdate({ pausedUntil: null }, { pausedUntil: until }, now)).toEqual({ value: expect.objectContaining({ pausedUntil: null }) });
    expect(mergeDoNotDisturbUpdate({ pausedUntil: '2020-01-01T00:00:00Z' }, undefined, now)).toEqual({ value: expect.objectContaining({ pausedUntil: null }) });
  });

  it('rejects invalid input', () => {
    const bad: unknown[] = [
      null, 'x', [],
      { pausedUntil: 'nope' },
      { pausedUntil: { $gt: 1 } },
      { pausedUntil: new Date(now.getTime() + MAX_PAUSE_MS + 60_000).toISOString() },
      { scheduleEnabled: 'yes' },
      { scheduleStart: '5pm' },
      { scheduleEnd: '24:00' },
      { daysOff: [7] },
      { daysOff: [1.5] },
      { daysOff: 'mon' },
      { timezone: 'Mars/Olympus' },
      { timezone: { $ne: null } },
    ];
    for (const input of bad) {
      expect(mergeDoNotDisturbUpdate(input, undefined, now)).toHaveProperty('error');
    }
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects others', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Nowhere/Land')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
