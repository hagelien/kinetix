import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchNotifications,
  fetchUnreadNotificationCount,
  markNotificationsRead,
} from './notificationsApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchNotifications', () => {
  it('requests the plain inbox with no query params by default', async () => {
    const fetchMock = stubFetch({ notifications: [], unreadCount: 0 });
    await fetchNotifications();
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications', undefined);
  });

  it('encodes unreadOnly and limit into the query string', async () => {
    const fetchMock = stubFetch({ notifications: [], unreadCount: 3 });
    const res = await fetchNotifications({ unreadOnly: true, limit: 10 });
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications?unread=1&limit=10', undefined);
    expect(res.unreadCount).toBe(3);
  });

  it('throws on a non-2xx response', async () => {
    stubFetch({ error: 'Authentication required' }, false, 401);
    await expect(fetchNotifications()).rejects.toThrow('Authentication required');
  });
});

describe('fetchUnreadNotificationCount', () => {
  it('returns just the unread count from the unread-only query', async () => {
    const fetchMock = stubFetch({ notifications: [], unreadCount: 7 });
    const count = await fetchUnreadNotificationCount();
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications?unread=1&limit=1', undefined);
    expect(count).toBe(7);
  });
});

describe('markNotificationsRead', () => {
  it('PATCHes explicit ids', async () => {
    const fetchMock = stubFetch({ updated: 2 });
    const res = await markNotificationsRead({ ids: [1, 2] });
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2] }),
    });
    expect(res.updated).toBe(2);
  });

  it('PATCHes all=true to clear the inbox', async () => {
    const fetchMock = stubFetch({ updated: 5 });
    await markNotificationsRead({ all: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
  });
});
