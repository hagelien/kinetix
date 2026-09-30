import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// No unit test may reach a live database.
//
// This is not tidiness. `callerCan` reads the `permission_overrides` table when
// the stored matrix could change a caller's answer, and falls back to the shipped
// defaults only when there is no database configured. So with `DATABASE_URL` set,
// a route test asserting an authorization outcome silently asserts the DEPLOYED
// policy instead of the shipped one — and passes or fails depending on whose
// machine it runs on and what an admin changed that morning.
//
// That is not hypothetical: `paper-extractions-route.test.ts` expects a
// contributor to be refused the extraction queue, and it failed for exactly this
// reason once a live override lowered `paperExtraction.queue.read` to contributor.
// The route was right, the shipped matrix was right, and the test was reading
// production.
//
// The DB-integration suite runs under `vitest.integration.config.ts` with its own
// setup and its own PGlite database (`setDbForTesting`), so it is unaffected.
delete process.env.DATABASE_URL;

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock crypto.randomUUID
Object.defineProperty(window, 'crypto', {
  value: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
  },
});

// Mock ResizeObserver
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverMock;

// Mock Web Worker
class WorkerMock {
  constructor() {}
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
}
window.Worker = WorkerMock as unknown as typeof Worker;
