import { AppDataSource } from '../src/database/data-source';

/**
 * Moves the seeded round into the current day.
 *
 * A driver's route is "today's work": stops.service.ts selects
 * `created_at >= date_trunc('day', now())`. That is right for the product,
 * dispatch assigns a fresh round each morning, but it means seeded demo data
 * silently expires at midnight UTC. The morning after a seed, the app signs in
 * correctly, syncs correctly, and shows an empty round, which reads as a
 * broken app rather than a finished day.
 *
 * Every stop older than today is shifted forward by the same whole number of
 * days, so the round keeps its shape: sequence, spread across the morning, and
 * which stops were already delivered. Nothing is deleted and no evidence is
 * touched; delivery_attempts are append-only and stay exactly where they are.
 *
 * Idempotent: once the newest stop is already in today, the shift is zero and
 * the script does nothing.
 */
async function main(): Promise<void> {
  await AppDataSource.initialize();

  const [{ shift }] = (await AppDataSource.query(`
    SELECT COALESCE(
      EXTRACT(DAY FROM date_trunc('day', now()) - date_trunc('day', max(created_at)))::int,
      0
    ) AS shift
    FROM stops
  `)) as Array<{ shift: number }>;

  if (shift <= 0) {
    console.log('Route already sits in today; nothing to roll.');
    await AppDataSource.destroy();
    return;
  }

  const result = (await AppDataSource.query(
    `UPDATE stops
        SET created_at = created_at + make_interval(days => $1),
            updated_at = now()
      WHERE created_at < date_trunc('day', now())`,
    [shift],
  )) as unknown;

  // TypeORM returns [rows, affected] for UPDATE on postgres.
  const affected = Array.isArray(result) ? (result[1] as number) : 0;

  const [counts] = (await AppDataSource.query(`
    SELECT count(*)::int AS today,
           count(*) FILTER (WHERE status = 'pending')::int AS pending
    FROM stops
    WHERE created_at >= date_trunc('day', now())
  `)) as Array<{ today: number; pending: number }>;

  console.log(`Rolled ${affected} stops forward by ${shift} day(s).`);
  console.log(`Today now has ${counts.today} stops (${counts.pending} pending).`);

  await AppDataSource.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
