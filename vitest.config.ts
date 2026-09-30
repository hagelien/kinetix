import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { splitByEnvironment } from './vitest.env-split';

// The unit suite is split into two projects that differ in one setting:
// `environment`. Building a jsdom per test file was the largest single line
// item in this suite — larger than running the tests:
//
//   Duration 253s (transform 22s, setup 95s, import 150s, tests 143s,
//                  environment 269s)
//
// 417 files, about half of which never touch a DOM (`tests/api/**` alone is
// ~100 route tests asserting on request and response objects). Those now run
// under plain Node, without jsdom and without the React setup file.
//
// The partition is derived rather than listed — `src/lib/**` is almost exactly
// half and half, so no path rule expresses it, and a 125-path list would go
// stale in a tree this active. `vitest.env-split.ts` documents how it is
// decided and why every uncertainty resolves to jsdom.
const { dom, node } = splitByEnvironment();

const alias = {
  '@': path.resolve(__dirname, './src'),
  '@db': path.resolve(__dirname, './db'),
};

// The DB-integration suite (tests/integration/**, tests/governance/**) runs
// under its own Node projects (vitest.integration.config.ts); keep it out of
// the unit run.
const exclude = [...configDefaults.exclude, 'tests/integration/**', 'tests/governance/**'];

export default defineConfig({
  test: {
    projects: [
      {
        // Components, pages, stores, and any lib whose import graph reaches
        // React or a browser global.
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'unit-dom',
          globals: true,
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: dom,
          exclude,
        },
      },
      {
        // Pure logic: route handlers, kinetics maths, parsing, formatting.
        // No jsdom, and no `src/test/setup.ts` — that file exists to install
        // React Testing Library's cleanup and to stub browser globals
        // (localStorage, ResizeObserver, Worker), none of which these tests
        // have any use for. It also deletes `DATABASE_URL`, which matters for
        // the route tests in this project, so that one line is reproduced in
        // `src/test/setup.node.ts`.
        resolve: { alias },
        test: {
          name: 'unit-node',
          globals: true,
          environment: 'node',
          setupFiles: ['./src/test/setup.node.ts'],
          include: node,
          exclude,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'api/**/*.{ts,tsx}',
        'data/**/*.{ts,tsx}',
        'db/**/*.{ts,tsx}',
        'scripts/**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
        'src/**/*.{ts,tsx}',
      ],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/__tests__/**',
        '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/*',
      ],
    },
  },
});
