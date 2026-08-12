/**
 * e2e suites need a real Postgres. They used to be invisible to `npm test`
 * (jest's rootDir is `src`, and these are `.e2e-spec.ts`), which is how the
 * legacy contract suite came to be broken for six commits without anyone
 * noticing.
 *
 * They are wired into `npm test` now, so the no-database case has to skip
 * rather than fail, and skip LOUDLY: a suite reporting zero tests is the same
 * silence we just removed. Reachability is probed once in global-setup.ts,
 * because DATABASE_URL is always set here whether or not anything is listening.
 */
const reachable = process.env.E2E_DB_REACHABLE === '1';

export const describeWithDb: jest.Describe = reachable
  ? describe
  : (describe.skip as jest.Describe);

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n  e2e SKIPPED: ${process.env.E2E_DB_REASON || 'no database'}.\n` +
      '  These pin the frozen v1 contract. To run them:\n' +
      '    docker compose -f ../infra/docker-compose.dev.yml up -d && npm run seed\n',
  );
}
