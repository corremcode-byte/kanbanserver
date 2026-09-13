/**
 * Remaining backend utilities: symmetric encryption, response envelopes,
 * out-of-office derivation and URL helpers.
 *
 * No real secret is used anywhere — every value is a fixture string.
 */

import { encrypt, decrypt } from '../encryption';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  unauthorizedResponse,
  forbiddenResponse,
  internalServerErrorResponse,
  validationErrorResponse,
  tooManyRequestsResponse,
} from '../responses';
import { getCurrentOutOfOfficePeriod, summarizeOutOfOffice } from '../outOfOffice';
import { getBaseUrl, toAbsoluteUrl } from '../urlHelper';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function bodyOf(res: any) {
  return res.json.mock.calls[0][0];
}

describe('encryption — symmetric round trip', () => {
  const FIXTURE = 'fixture-plaintext-value';

  it('round-trips a value through encrypt then decrypt', () => {
    const cipher = encrypt(FIXTURE);

    expect(cipher).not.toBe(FIXTURE);
    expect(decrypt(cipher)).toBe(FIXTURE);
  });

  it('emits an iv:ciphertext hex envelope that hides the plaintext', () => {
    const cipher = encrypt(FIXTURE);

    expect(cipher).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
    expect(cipher).not.toContain(FIXTURE);
  });

  it('is non-deterministic — the same input encrypts differently each time', () => {
    expect(encrypt(FIXTURE)).not.toBe(encrypt(FIXTURE));
  });

  it('round-trips unicode and emoji intact', () => {
    const tricky = 'héllo ☃ \u{1F600} — dash';

    expect(decrypt(encrypt(tricky))).toBe(tricky);
  });

  it('round-trips an empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('round-trips a long value without truncation', () => {
    const long = 'x'.repeat(5000);

    expect(decrypt(encrypt(long))).toBe(long);
  });

  it('throws on ciphertext with no iv separator', () => {
    expect(() => decrypt('no-separator-here')).toThrow();
  });

  // FINDING (documented, NOT fixed): the cipher is AES-256-CBC with no MAC, so
  // it provides confidentiality but NOT integrity. Tampering with the
  // ciphertext is not reliably detected — it either throws on a padding error
  // or silently yields different plaintext. Callers cannot treat a successful
  // decrypt as proof the value is unmodified.
  it('does not authenticate ciphertext — tampering yields garbage or throws, never a clean reject', () => {
    const cipher = encrypt(FIXTURE);
    const [iv, body] = cipher.split(':');
    const flipped = body.startsWith('a') ? `b${body.slice(1)}` : `a${body.slice(1)}`;

    let result: string | null = null;
    try {
      result = decrypt(`${iv}:${flipped}`);
    } catch {
      result = null;
    }

    // Either outcome is possible; what must never happen is returning the
    // original plaintext from a modified ciphertext.
    expect(result).not.toBe(FIXTURE);
  });

  it('changes the plaintext when the iv is altered, without detecting the change', () => {
    const cipher = encrypt(FIXTURE);
    const body = cipher.split(':')[1];
    const otherIv = 'f'.repeat(32);

    let result: string | null = null;
    try {
      result = decrypt(`${otherIv}:${body}`);
    } catch {
      result = null;
    }

    expect(result).not.toBe(FIXTURE);
  });

  it('throws when the iv has been replaced with one of the wrong length', () => {
    const cipher = encrypt(FIXTURE);

    expect(() => decrypt(`abcd:${cipher.split(':')[1]}`)).toThrow();
  });

  it('does not decrypt correctly under a different key', () => {
    const original = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'key-number-one';
    const cipher = encrypt(FIXTURE);

    process.env.ENCRYPTION_KEY = 'key-number-two';
    let result: string | null = null;
    try {
      result = decrypt(cipher);
    } catch {
      result = null; // most tampering surfaces as a throw
    }
    expect(result).not.toBe(FIXTURE);

    process.env.ENCRYPTION_KEY = original;
  });
});

describe('response helpers — envelope shape and status codes', () => {
  it('successResponse defaults to 200 with a success envelope', () => {
    const res = makeRes();

    successResponse(res, 'Done', { id: 1 });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(bodyOf(res)).toEqual({ success: true, message: 'Done', data: { id: 1 } });
  });

  it('successResponse honours an explicit status code', () => {
    const res = makeRes();

    successResponse(res, 'Created', { id: 1 }, 201);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('successResponse omits data when none is supplied', () => {
    const res = makeRes();

    successResponse(res, 'Done');

    expect(bodyOf(res).data).toBeUndefined();
  });

  it('errorResponse defaults to 400 and never carries a data field', () => {
    const res = makeRes();

    errorResponse(res, 'Bad input');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(bodyOf(res)).toEqual({ success: false, message: 'Bad input' });
  });

  it('maps each helper to its documented status code', () => {
    const cases: Array<[Function, number, string]> = [
      [notFoundResponse, 404, 'Resource not found'],
      [unauthorizedResponse, 401, 'Unauthorized'],
      [forbiddenResponse, 403, 'Forbidden'],
      [internalServerErrorResponse, 500, 'Internal server error'],
      [tooManyRequestsResponse, 429, 'Too many requests'],
    ];

    for (const [helper, status, defaultMessage] of cases) {
      const res = makeRes();
      helper(res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(bodyOf(res)).toEqual({ success: false, message: defaultMessage });
    }
  });

  it('validationErrorResponse returns 422 with the error list', () => {
    const res = makeRes();

    validationErrorResponse(res, 'Invalid', [{ field: 'email' }]);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(bodyOf(res)).toEqual({
      success: false,
      message: 'Invalid',
      errors: [{ field: 'email' }],
    });
  });

  it('every error helper reports success:false', () => {
    for (const helper of [
      errorResponse,
      notFoundResponse,
      unauthorizedResponse,
      forbiddenResponse,
      internalServerErrorResponse,
      tooManyRequestsResponse,
    ]) {
      const res = makeRes();
      (helper as any)(res, 'msg');
      expect(bodyOf(res).success).toBe(false);
    }
  });
});

describe('out-of-office derivation', () => {
  const period = (start: string, end: string, reason = 'Leave') => ({
    startDate: new Date(start),
    endDate: new Date(end),
    reason,
  });

  it('returns null when there are no periods', () => {
    expect(getCurrentOutOfOfficePeriod(undefined)).toBeNull();
    expect(getCurrentOutOfOfficePeriod([])).toBeNull();
  });

  it('finds the period covering the given instant', () => {
    const periods = [period('2026-01-01', '2026-01-10')];

    expect(getCurrentOutOfOfficePeriod(periods, new Date('2026-01-05'))).toBe(periods[0]);
  });

  it('treats both range boundaries as inclusive', () => {
    const periods = [period('2026-01-01T00:00:00.000Z', '2026-01-10T23:59:59.999Z')];

    expect(getCurrentOutOfOfficePeriod(periods, new Date('2026-01-01T00:00:00.000Z'))).toBe(
      periods[0]
    );
    expect(getCurrentOutOfOfficePeriod(periods, new Date('2026-01-10T23:59:59.999Z'))).toBe(
      periods[0]
    );
  });

  it('returns null just outside the range on either side', () => {
    const periods = [period('2026-01-01T00:00:00.000Z', '2026-01-10T23:59:59.999Z')];

    expect(getCurrentOutOfOfficePeriod(periods, new Date('2025-12-31T23:59:59.998Z'))).toBeNull();
    expect(getCurrentOutOfOfficePeriod(periods, new Date('2026-01-11T00:00:00.001Z'))).toBeNull();
  });

  it('returns the first matching period when several overlap', () => {
    const periods = [period('2026-01-01', '2026-01-31', 'A'), period('2026-01-05', '2026-01-10', 'B')];

    expect(getCurrentOutOfOfficePeriod(periods, new Date('2026-01-07'))!.reason).toBe('A');
  });

  it('accepts ISO date strings as well as Date objects', () => {
    const periods = [{ startDate: '2026-01-01', endDate: '2026-01-10' }];

    expect(getCurrentOutOfOfficePeriod(periods as any, new Date('2026-01-05'))).toBe(periods[0]);
  });

  it('summarizeOutOfOffice reports not-out with an empty period list', () => {
    expect(summarizeOutOfOffice(undefined)).toEqual({
      isOutOfOffice: false,
      currentPeriod: null,
      periods: [],
    });
  });

  it('summarizeOutOfOffice reports out-of-office while a period is active', () => {
    const periods = [
      period(
        new Date(Date.now() - 86_400_000).toISOString(),
        new Date(Date.now() + 86_400_000).toISOString()
      ),
    ];

    const summary = summarizeOutOfOffice(periods);

    expect(summary.isOutOfOffice).toBe(true);
    expect(summary.currentPeriod).toBe(periods[0]);
    expect(summary.periods).toBe(periods);
  });

  it('summarizeOutOfOffice preserves past periods while reporting not-out', () => {
    const periods = [period('2020-01-01', '2020-01-10')];

    const summary = summarizeOutOfOffice(periods);

    expect(summary.isOutOfOffice).toBe(false);
    expect(summary.periods).toHaveLength(1);
  });
});

describe('url helpers', () => {
  const originalBase = process.env.BASE_URL;
  const originalPort = process.env.PORT;

  afterEach(() => {
    if (originalBase === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = originalBase;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it('prefers BASE_URL and strips trailing slashes', () => {
    process.env.BASE_URL = 'https://app.example.com///';

    expect(getBaseUrl()).toBe('https://app.example.com');
  });

  it('falls back to localhost on the configured port', () => {
    delete process.env.BASE_URL;
    process.env.PORT = '5005';

    expect(getBaseUrl()).toBe('http://localhost:5005');
  });

  it('falls back to the default port when none is configured', () => {
    delete process.env.BASE_URL;
    delete process.env.PORT;

    expect(getBaseUrl()).toBe('http://localhost:4001');
  });

  it('returns null for an empty relative path', () => {
    expect(toAbsoluteUrl(null)).toBeNull();
    expect(toAbsoluteUrl(undefined)).toBeNull();
    expect(toAbsoluteUrl('')).toBeNull();
  });

  it('leaves an already-absolute URL untouched', () => {
    process.env.BASE_URL = 'https://app.example.com';

    expect(toAbsoluteUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(toAbsoluteUrl('http://cdn.example.com/a.png')).toBe('http://cdn.example.com/a.png');
  });

  it('joins a relative path onto the base URL', () => {
    process.env.BASE_URL = 'https://app.example.com';

    expect(toAbsoluteUrl('/uploads/a.png')).toBe('https://app.example.com/uploads/a.png');
  });

  it('adds the leading slash when the path omits it', () => {
    process.env.BASE_URL = 'https://app.example.com';

    expect(toAbsoluteUrl('uploads/a.png')).toBe('https://app.example.com/uploads/a.png');
  });
});
