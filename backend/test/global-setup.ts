import { createConnection } from 'node:net';

/**
 * Decides once, before any e2e suite runs, whether a database is actually
 * there.
 *
 * Checking `DATABASE_URL` is not enough: something in the import graph loads
 * .env, so the variable is always set and always points at localhost:5433
 * whether or not anything is listening. Gating on it therefore ran the whole
 * e2e suite against nothing and reported 22 failures that meant "no database",
 * which is exactly as unhelpful as the silent exclusion it replaced.
 *
 * So probe the socket. Reachable means run; unreachable means skip with a
 * reason. Suites run in band (maxWorkers: 1) so this assignment is visible to
 * them.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.env.E2E_DB_REACHABLE = '0';
    process.env.E2E_DB_REASON = 'DATABASE_URL is not set';
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
}
