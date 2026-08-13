// Loads .env, and it has to be first. Nothing else in this file's import graph
// reads it, so without this DATABASE_URL is simply unset and every e2e run
// skips with "DATABASE_URL is not set" even when Postgres is up and correct.
// That is how the frozen-v1 contract suite came to report 22 skipped tests on
// a machine where it should have been running, which is worse than failing:
// the tripwire looked present and was disarmed.
import 'dotenv/config';

import { createConnection } from 'node:net';

/**
 * Decides once, before any e2e suite runs, whether a database is actually
 * there.
 *
 * Checking `DATABASE_URL` is not enough on its own. With .env loaded above the
 * variable is always set and always points at localhost:5433, whether or not
 * anything is listening, so gating on the variable alone ran the whole e2e
 * suite against nothing and reported 22 failures that meant "no database" -
 * exactly as unhelpful as the silent exclusion it replaced.
 *
 * So probe the socket. Reachable means run; unreachable means skip with a
 * reason, printed from here rather than from the suites: jest attaches console
 * output to a running test, so a warning emitted by a skipped suite is
 * swallowed and the skip goes silent again. Suites run in band (maxWorkers: 1)
 * so this assignment is visible to them.
 */
function announceSkip(reason: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `\n  e2e SKIPPED: ${reason}.\n` +
      '  These pin the frozen v1 contract, which v1.4.2 handsets depend on.\n' +
      '  To run them, start Postgres and apply the schema:\n' +
      '    docker compose -f ../infra/docker-compose.dev.yml up -d\n' +
      '    npm run migrate && npm run seed\n',
  );
}

export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.env.E2E_DB_REACHABLE = '0';
    process.env.E2E_DB_REASON = 'DATABASE_URL is not set';
    announceSkip(process.env.E2E_DB_REASON);
    return;
  }

  const { hostname, port } = new URL(url);
  const target = `${hostname}:${port || '5432'}`;

  const reachable = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(port || 5432) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });

  process.env.E2E_DB_REACHABLE = reachable ? '1' : '0';
  process.env.E2E_DB_REASON = reachable ? '' : `no database listening on ${target}`;

  if (!reachable) announceSkip(process.env.E2E_DB_REASON);
}
