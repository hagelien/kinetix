import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChunkReloadHandler } from './chunkReload';

function makeFakeWindow() {
  const target = new EventTarget();
  const store = new Map<string, string>();
  const reload = vi.fn();
  const win = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    sessionStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
    location: { reload },
  } as unknown as Window;
  return { win, reload, store };
}

function firePreloadError(win: Window): Event {
  const event = new Event('vite:preloadError', { cancelable: true });
  win.dispatchEvent(event);
  return event;
}

describe('installChunkReloadHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads and cancels the event on a preload error', () => {
    const { win, reload } = makeFakeWindow();
    installChunkReloadHandler(win);

    const event = firePreloadError(win);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not reload twice inside the suppression window', () => {
    const { win, reload } = makeFakeWindow();
    installChunkReloadHandler(win);

    firePreloadError(win);
    vi.advanceTimersByTime(2_000);
    const second = firePreloadError(win);

    expect(reload).toHaveBeenCalledTimes(1);
    // The second error is left to surface (not handled) so it can't loop.
    expect(second.defaultPrevented).toBe(false);
  });

  it('reloads again once the suppression window has elapsed', () => {
    const { win, reload } = makeFakeWindow();
    installChunkReloadHandler(win);

    firePreloadError(win);
    vi.advanceTimersByTime(11_000);
    firePreloadError(win);

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('persists the last reload time across handler installs (same tab)', () => {
    const { win, reload } = makeFakeWindow();

    // Simulate the pre-reload page load.
    installChunkReloadHandler(win);
    firePreloadError(win);
    expect(reload).toHaveBeenCalledTimes(1);

    // After the reload, a fresh handler installs on the new page load. A chunk
    // error immediately after must not loop because sessionStorage remembers.
    vi.advanceTimersByTime(1_000);
    installChunkReloadHandler(win);
    firePreloadError(win);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
