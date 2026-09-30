import { defineConfig } from 'vitest/config';
import path from 'path';

// Separate project for the PGlite-backed DB-integration suite (#791 Part A).
// Kept apart from the fast mocked unit suite (vitest.config.ts): it runs in a
// Node environment (no jsdom), boots a real in-process Postgres per file, and
// executes the app's actual SQL. Run with `npm run test:integration`.
//
// Split into two projects so they can differ on one setting: `isolate`.
//
// Isolation is what made this suite the most expensive thing the repo runs on
// a PR. With it on, vitest gives every test file a fresh module registry, so
// the PGlite instance in tests/integration/setup/harness.ts cannot outlive a
// file and each of the 51 integration files booted its own WASM Postgres —
// ~2.7s of boot apiece, dwarfing the ~0.6s the migration chain itself costs to
// replay. Turning isolation off lets one instance serve every file its worker
// runs, which takes the suite from ~135s to ~48s locally.
//
// Two groups of files do not survive that, both for the same reason: a shared
// module registry is also a shared *mock* registry, so a `vi.mock` factory
// installed by one file is still installed when the next one runs. They fail
// non-deterministically when that happens — a different file each run,
// depending on the order the worker picked. Rather than rewrite them to suit a
// performance change, they keep the fresh registry:
//
//   * the integration files that call `vi.mock` (listed in MOCKED below)
//   * the governance contract tests, a frozen Phase 0 spec whose files carry
//     module-level state between them
//
// Both groups are small — 15 files that run in a few seconds — so isolating
// them costs little of what turning isolation off buys.

// The integration files that install module mocks. Keep this in sync with
// `grep -l 'vi\.mock' tests/integration/*.test.ts`; a file that starts mocking
// without moving here becomes an intermittent failure somewhere else — which
// is what drug-delete-parameter-entries did, failing its admin-auth mock with
// a 403 whenever the worker had loaded the real auth module first.
// tests/integration-mocked-files.test.ts now enforces the sync.
const MOCKED = [
  'tests/integration/agent-audit-sample.test.ts',
  'tests/integration/agent-consensus-retry.test.ts',
  'tests/integration/agent-escalation-queue.test.ts',
  'tests/integration/agent-focus-skip-wiki-content.test.ts',
  'tests/integration/agent-focus-wiki-pages-route.test.ts',
  'tests/integration/agent-focus-wiki-scope.test.ts',
  'tests/integration/agent-self-review.test.ts',
  'tests/integration/agent-verification-queue-submitters.test.ts',
  'tests/integration/agent-verifications-queue-hydration.test.ts',
  'tests/integration/agent-verifications-queue-revisit-abstained.test.ts',
  'tests/integration/agent-verifications-queue-target-id.test.ts',
  'tests/integration/agent-verifications-own-verdict-visibility.test.ts',
  'tests/integration/cmax-authoring.test.ts',
  'tests/integration/conversation-ingestion-rollback.test.ts',
  'tests/integration/drug-delete-parameter-entries.test.ts',
  'tests/integration/drug-parameter-history-verifications.test.ts',
  'tests/integration/drug-parameter-history.test.ts',
  'tests/integration/drug-scoped-submission-drug-lock.test.ts',
  'tests/integration/methods-components-atomicity.test.ts',
  'tests/integration/notification-email-delivery.test.ts',
  'tests/integration/pdf-inbox.test.ts',
  'tests/integration/pending-edits-consensus-status-batch.test.ts',
  'tests/integration/pending-edits-drug-lock.test.ts',
  'tests/integration/simulator-cases-drug-lock.test.ts',
  'tests/integration/verdict-reconsideration.test.ts',
  'tests/integration/wiki-monograph-drug-lock.test.ts',
];
const alias = {
  '@': path.resolve(__dirname, './src'),
  '@db': path.resolve(__dirname, './db'),
};

// Booting a WASM Postgres and replaying 110+ migrations costs a beat; give the
// per-file setup room without tripping the default 5s hook timeout.
const timeouts = { hookTimeout: 60000, testTimeout: 30000 };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'integration',
          globals: true,
          environment: 'node',
          include: ['tests/integration/**/*.{test,spec}.ts'],
          exclude: MOCKED,
          // Safe here, and the whole point: see the note above.
          isolate: false,
          ...timeouts,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration-mocked',
          globals: true,
          environment: 'node',
          include: MOCKED,
          // These install `vi.mock` factories; a shared registry leaks them.
          isolate: true,
          ...timeouts,
        },
      },
      {
        // tests/governance/legacy-contract holds the Phase 0 freeze-behaviour
        // contract tests (docs/plans/2026-08-26-general-knowledge-governance-
        // extraction.md) — same PGlite harness, separate directory so it reads
        // as a frozen spec rather than routine route coverage.
        resolve: { alias },
        test: {
          name: 'governance',
          globals: true,
          environment: 'node',
          include: ['tests/governance/**/*.{test,spec}.ts'],
          // These leak module state across files; keep the fresh registry.
          isolate: true,
          ...timeouts,
        },
      },
    ],
  },
});
