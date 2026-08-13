/**
 * e2e suites need a real Postgres. They used to be invisible to `npm test`
 * (jest's rootDir is `src`, and these are `.e2e-spec.ts`), which is how the
 * legacy contract suite came to be broken for six commits without anyone
 * noticing.
 *
 * They are wired into `npm test` now, so the no-database case has to skip
 * rather than fail, and skip LOUDLY: a suite reporting zero tests is the same
 * silence we just removed. Reachability is probed once in global-setup.ts,
 * which also loads .env, because DATABASE_URL being unset is itself a skip
 * reason and one that used to be indistinguishable from a missing database.
 *
 * The warning is printed by global-setup.ts, not here. Jest attaches console
 * output to a running test, so a warning emitted at module scope by a suite
 * that then skips is swallowed - which is precisely how this skip went silent
 * while looking like it was covered.
 */
const reachable = process.env.E2E_DB_REACHABLE === '1';

export const describeWithDb: jest.Describe = reachable
  ? describe
  : (describe.skip as jest.Describe);
