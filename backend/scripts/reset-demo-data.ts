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
/** Exactly what the k6 load generator writes. Nothing else is deletable here. */
const LOAD_TEST_NOTE = 'left by the side door under the porch';

async function main(): Promise<void> {
  // A demo-fixture script that deletes from an append-only evidence table has
  // no business running unattended against real data. It runs as the owner
  // role, so the column grants that protect delivery_attempts do not apply to
  // it, and the confirmation is the only thing left between a mistyped
  // DATABASE_URL and unrecoverable loss.
  if (process.env.CONFIRM_DESTRUCTIVE !== 'yes-delete-demo-attempts') {
    console.error(
      'Refusing to run.\n' +
        'This DELETEs from delivery_attempts as the database owner.\n' +
        'Set CONFIRM_DESTRUCTIVE=yes-delete-demo-attempts if that is genuinely what you want.',
    );
    process.exit(1);
  }

  await AppDataSource.initialize();

  const [before] = (await AppDataSource.query(
    `SELECT count(*)::int AS attempts FROM delivery_attempts WHERE source = 'v2'`,
  )) as Array<{ attempts: number }>;
  console.log(`v2 attempts before: ${before.attempts}`);

  await AppDataSource.transaction(async (em) => {
    // Synthetic traffic is identifiable by the note the load generator writes.
    //
    // This clause used to end `OR note IS NULL`, which was catastrophic: a note
    // is optional for a real driver, and most no_answer_carded and
    // left_safe_place attempts carry none. Run against real data it would have
    // deleted genuine evidence, as the owner role, past the column grants that
    // exist precisely to make that impossible.
    //
    // Under-deleting leaves a few tidy-looking rows behind. Over-deleting
    // destroys evidence irreversibly. On this table the asymmetry is the whole
    // argument, so the marker must match exactly and nothing else qualifies.
    const synthetic = `
      SELECT id FROM delivery_attempts
      WHERE source = 'v2'
        AND note = '${LOAD_TEST_NOTE}'
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
