/**
 * dynamicRouteStore — in-memory path (no REDIS_URL), which is what runs in
 * single-instance deployments. Covers the one-live-token-per-destination rule:
 * a still-valid token is reused (not rotated), so other tabs holding the same
 * /r/<token> URL keep working.
 */

jest.mock('ioredis', () => jest.fn());

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
delete process.env.REDIS_URL;

import { dynamicRouteStore } from '../dynamicRouteStore';

const USER_A = 'user-a';
const USER_B = 'user-b';
const THIRTY_ONE_MINUTES = 31 * 60 * 1000;

afterAll(() => {
  if (ORIGINAL_REDIS_URL !== undefined) process.env.REDIS_URL = ORIGINAL_REDIS_URL;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await dynamicRouteStore.clearUserRoutes(USER_A);
  await dynamicRouteStore.clearUserRoutes(USER_B);
});

describe('dynamicRouteStore.generateRoute', () => {
  it('issues a 24-char URL-safe token that validates to its destination', async () => {
    const token = await dynamicRouteStore.generateRoute(USER_A, '/dashboard');
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const entry = await dynamicRouteStore.validateRoute(token);
    expect(entry).toMatchObject({ userId: USER_A, destination: '/dashboard' });
  });

  it('reuses the live token for the same user and destination instead of rotating it', async () => {
    const first = await dynamicRouteStore.generateRoute(USER_A, '/dashboard');
    const second = await dynamicRouteStore.generateRoute(USER_A, '/dashboard');
    expect(second).toBe(first);
  });

  it('keeps an earlier token valid after the same page is requested again (multi-tab)', async () => {
    const tabOne = await dynamicRouteStore.generateRoute(USER_A, '/projects');
    await dynamicRouteStore.generateRoute(USER_A, '/projects'); // e.g. a second tab / hover prefetch
    expect(await dynamicRouteStore.validateRoute(tabOne)).toMatchObject({ destination: '/projects' });
  });

  it('issues distinct tokens for different destinations', async () => {
    const a = await dynamicRouteStore.generateRoute(USER_A, '/dashboard');
    const b = await dynamicRouteStore.generateRoute(USER_A, '/my-tasks');
    expect(a).not.toBe(b);
  });

  it('never shares a token between users for the same destination', async () => {
    const a = await dynamicRouteStore.generateRoute(USER_A, '/dashboard');
    const b = await dynamicRouteStore.generateRoute(USER_B, '/dashboard');
    expect(a).not.toBe(b);
    expect(await dynamicRouteStore.validateRoute(b)).toMatchObject({ userId: USER_B });
  });

  it('issues a fresh token once the previous one has expired', async () => {
    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    const first = await dynamicRouteStore.generateRoute(USER_A, '/notes');

    nowSpy.mockReturnValue(start + THIRTY_ONE_MINUTES);
    expect(await dynamicRouteStore.validateRoute(first)).toBeNull();

    const second = await dynamicRouteStore.generateRoute(USER_A, '/notes');
    expect(second).not.toBe(first);
    expect(await dynamicRouteStore.validateRoute(second)).toMatchObject({ destination: '/notes' });
  });

  it('refreshes the inactivity window when a live token is reused', async () => {
    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    const token = await dynamicRouteStore.generateRoute(USER_A, '/chat');

    nowSpy.mockReturnValue(start + 20 * 60 * 1000);           // 20 min later: reuse refreshes TTL
    expect(await dynamicRouteStore.generateRoute(USER_A, '/chat')).toBe(token);

    nowSpy.mockReturnValue(start + 20 * 60 * 1000 + 25 * 60 * 1000); // 45 min total, 25 since refresh
    expect(await dynamicRouteStore.validateRoute(token)).toMatchObject({ destination: '/chat' });
  });
});

describe('dynamicRouteStore.clearUserRoutes (logout)', () => {
  it('invalidates every token for the user, and a new one is issued afterwards', async () => {
    const before = await dynamicRouteStore.generateRoute(USER_A, '/dashboard');
    await dynamicRouteStore.clearUserRoutes(USER_A);

    expect(await dynamicRouteStore.validateRoute(before)).toBeNull();
    const after = await dynamicRouteStore.generateRoute(USER_A, '/dashboard');
    expect(after).not.toBe(before);
  });

  it('does not touch other users’ tokens', async () => {
    const other = await dynamicRouteStore.generateRoute(USER_B, '/dashboard');
    await dynamicRouteStore.generateRoute(USER_A, '/dashboard');
    await dynamicRouteStore.clearUserRoutes(USER_A);
    expect(await dynamicRouteStore.validateRoute(other)).toMatchObject({ userId: USER_B });
  });
});

describe('dynamicRouteStore.generatePublicRoute', () => {
  it('still issues tokens for permitted public pages only', async () => {
    const token = await dynamicRouteStore.generatePublicRoute('/shiva');
    expect(await dynamicRouteStore.validateRoute(token)).toMatchObject({ destination: '/shiva', isPublic: true });
    await expect(dynamicRouteStore.generatePublicRoute('/dashboard')).rejects.toThrow();
  });
});
