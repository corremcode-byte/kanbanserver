// Do Not Disturb — decides whether a user should be left alone right now and
// validates settings updates. Evaluated in the user's own time zone (captured
// from their browser) so "17:00–09:00" means their evening, not the server's.
//
// While DND is active the in-app notification is still stored (bell/inbox stay
// complete); only interruptive delivery (web push) is suppressed.

export interface DoNotDisturbSettings {
  /** "Pause notifications" — active until this instant. */
  pausedUntil?: Date | string | null;
  /** Daily quiet hours. */
  scheduleEnabled?: boolean;
  scheduleStart?: string; // 'HH:mm'
  scheduleEnd?: string;   // 'HH:mm'
  /** Whole days off, 0 = Sunday … 6 = Saturday. */
  daysOff?: number[];
  /** IANA time zone, e.g. 'Asia/Kolkata'. */
  timezone?: string;
}

export const DND_DEFAULTS: Required<Omit<DoNotDisturbSettings, 'pausedUntil'>> & { pausedUntil: null } = {
  pausedUntil: null,
  scheduleEnabled: false,
  scheduleStart: '17:00',
  scheduleEnd: '09:00',
  daysOff: [],
  timezone: 'UTC',
};

/** Longest allowed "Pause notifications" window. */
export const MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Weekday (0–6) and minutes since midnight at `now` in `timezone`. */
function localDayAndMinutes(now: Date, timezone?: string): { day: number; minutes: number } {
  const tz = isValidTimeZone(timezone) ? timezone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: WEEKDAYS[get('weekday')] ?? now.getUTCDay(),
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

export function isDoNotDisturbActive(dnd: DoNotDisturbSettings | null | undefined, now: Date = new Date()): boolean {
  if (!dnd) return false;

  if (dnd.pausedUntil) {
    const until = new Date(dnd.pausedUntil).getTime();
    if (!Number.isNaN(until) && until > now.getTime()) return true;
  }

  const hasDaysOff = Array.isArray(dnd.daysOff) && dnd.daysOff.length > 0;
  const hasSchedule = !!dnd.scheduleEnabled
    && typeof dnd.scheduleStart === 'string' && TIME_RE.test(dnd.scheduleStart)
    && typeof dnd.scheduleEnd === 'string' && TIME_RE.test(dnd.scheduleEnd);
  if (!hasDaysOff && !hasSchedule) return false;

  const { day, minutes } = localDayAndMinutes(now, dnd.timezone);

  if (hasDaysOff && dnd.daysOff!.includes(day)) return true;

  if (hasSchedule) {
    const start = toMinutes(dnd.scheduleStart!);
    const end = toMinutes(dnd.scheduleEnd!);
    if (start === end) return false; // empty window
    return start < end
      ? minutes >= start && minutes < end        // same-day window, e.g. 12:00–14:00
      : minutes >= start || minutes < end;       // overnight window, e.g. 17:00–09:00
  }
  return false;
}

/**
 * Validates a (partial) DND update and merges it onto the current value.
 * Returns the full settings object to store, or an error message.
 */
export function mergeDoNotDisturbUpdate(
  input: unknown,
  current: DoNotDisturbSettings | null | undefined,
  now: Date = new Date(),
): { value: DoNotDisturbSettings } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'doNotDisturb must be an object' };
  }
  const src = input as Record<string, unknown>;
  const base: DoNotDisturbSettings = {
    pausedUntil: current?.pausedUntil ?? DND_DEFAULTS.pausedUntil,
    scheduleEnabled: current?.scheduleEnabled ?? DND_DEFAULTS.scheduleEnabled,
    scheduleStart: current?.scheduleStart || DND_DEFAULTS.scheduleStart,
    scheduleEnd: current?.scheduleEnd || DND_DEFAULTS.scheduleEnd,
    daysOff: Array.isArray(current?.daysOff) ? [...current!.daysOff!] : [...DND_DEFAULTS.daysOff],
    timezone: current?.timezone || DND_DEFAULTS.timezone,
  };

  if ('pausedUntil' in src) {
    const v = src.pausedUntil;
    if (v === null || v === '') {
      base.pausedUntil = null;
    } else if (typeof v === 'string' || typeof v === 'number') {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return { error: 'pausedUntil must be a valid date' };
      if (d.getTime() - now.getTime() > MAX_PAUSE_MS) return { error: 'Notifications can be paused for at most 30 days' };
      // A time in the past simply means "not paused".
      base.pausedUntil = d.getTime() > now.getTime() ? d : null;
    } else {
      return { error: 'pausedUntil must be a date or null' };
    }
  }

  if ('scheduleEnabled' in src) {
    if (typeof src.scheduleEnabled !== 'boolean') return { error: 'scheduleEnabled must be a boolean' };
    base.scheduleEnabled = src.scheduleEnabled;
  }

  for (const key of ['scheduleStart', 'scheduleEnd'] as const) {
    if (key in src) {
      const v = src[key];
      if (typeof v !== 'string' || !TIME_RE.test(v)) return { error: `${key} must be a time in HH:mm format` };
      base[key] = v;
    }
  }

  if ('daysOff' in src) {
    const v = src.daysOff;
    if (!Array.isArray(v) || v.length > 7 || !v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return { error: 'daysOff must be a list of weekdays (0–6)' };
    }
    base.daysOff = [...new Set(v as number[])].sort((a, b) => a - b);
  }

  if ('timezone' in src) {
    if (!isValidTimeZone(src.timezone)) return { error: 'timezone must be a valid IANA time zone' };
    base.timezone = src.timezone;
  }

  return { value: base };
}
