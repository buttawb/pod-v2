import { AppDataSource } from '../src/database/data-source';

/**
 * Restores the demo dataset to a believable delivery day.
 *
 * Load testing writes tens of thousands of synthetic attempts that never
 * upload photos, which leaves the office dashboard showing a fleet that
 * delivered 5,000 parcels and is awaiting evidence on every one of them.
 * That is a worse first impression than an empty screen.
 *
 * This runs as the OWNER role, never as the API's role: `pod_app` holds no
 * DELETE on evidence tables by design, and that guarantee is not weakened
 * for the convenience of a demo script.
 */
async function main(): Promise<void> {
  await AppDataSource.initialize();

  const [before] = (await AppDataSource.query(
    `SELECT count(*)::int AS attempts FROM delivery_attempts WHERE source = 'v2'`,
  )) as Array<{ attempts: number }>;
  console.log(`v2 attempts before: ${before.attempts}`);

  await AppDataSource.transaction(async (em) => {
    // Synthetic traffic is identifiable: the load generator signs in as the
    // seeded fleet and always writes the same note.
    const synthetic = `
      SELECT id FROM delivery_attempts
      WHERE source = 'v2'
        AND (note = 'left by the side door under the porch' OR note IS NULL)
    `;

    await em.query(`DELETE FROM ai_summaries WHERE attempt_id IN (${synthetic})`);
    await em.query(`DELETE FROM attempt_photos WHERE attempt_id IN (${synthetic})`);
    await em.query(
      `DELETE FROM pods WHERE stop_id IN (SELECT stop_id FROM delivery_attempts WHERE id IN (${synthetic}))
         AND stop_id IN (SELECT id FROM stops WHERE created_at >= date_trunc('day', now()))`,
    );
    await em.query(`DELETE FROM delivery_attempts WHERE id IN (${synthetic})`);

    // Any stop with no surviving attempt goes back to pending.
    await em.query(`
      UPDATE stops SET status = 'pending', latest_attempt_id = NULL, updated_at = now()
      WHERE created_at >= date_trunc('day', now())
        AND NOT EXISTS (SELECT 1 FROM delivery_attempts a WHERE a.stop_id = stops.id)
    `);
  });

  const [after] = (await AppDataSource.query(
    `SELECT
       (SELECT count(*)::int FROM delivery_attempts WHERE source = 'v2') AS attempts,
       (SELECT count(*)::int FROM stops WHERE created_at >= date_trunc('day', now())
          AND status = 'pending') AS pending`,
  )) as Array<{ attempts: number; pending: number }>;
  console.log(`v2 attempts after:  ${after.attempts}`);
  console.log(`stops pending:      ${after.pending}`);

  await AppDataSource.destroy();
}

void main();
