// Setup for the `unit-node` project — the half of the unit suite that runs
// without jsdom.
//
// `src/test/setup.ts` does two unrelated things: it stubs browser globals for
// React Testing Library, and it removes `DATABASE_URL`. Only the second one
// matters here, and it matters *more* here than there, because the route
// tests that depend on it are in this project.
//
// The reasoning, copied from `setup.ts` because it is the whole point of this
// file: `callerCan` reads the `permission_overrides` table when the stored
// matrix could change a caller's answer, and falls back to the shipped
// defaults only when there is no database configured. So with `DATABASE_URL`
// set, a route test asserting an authorization outcome silently asserts the
// DEPLOYED policy instead of the shipped one — and passes or fails depending
// on whose machine it runs on and what an admin changed that morning.
//
// That is not hypothetical: `paper-extractions-route.test.ts` expects a
// contributor to be refused the extraction queue, and it failed for exactly
// this reason once a live override lowered `paperExtraction.queue.read` to
// contributor. The route was right, the shipped matrix was right, and the test
// was reading production.
//
// The DB-integration suite runs under `vitest.integration.config.ts` with its
// own setup and its own PGlite database (`setDbForTesting`), so it is
// unaffected.
delete process.env.DATABASE_URL;
