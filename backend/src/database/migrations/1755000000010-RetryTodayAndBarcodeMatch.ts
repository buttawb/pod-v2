import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Three facts the driver establishes at the door, recorded with the attempt.
 *
 * retry_today: a carded or no-access attempt can mean either "coming back
 * later today" or "done here for the day", and the outcome code alone cannot
 * say which. Without it the round either loses stops the driver still intends
 * to work or keeps dead ones live. Deliberately not a new stops.status value:
 * status is projected into the frozen v1 surface's neighbourhood and the
 * existing enum is load-bearing, so the flag lives on the attempt and the day
 * list derives from the latest one.
 *
 * barcode_match / barcode_override_reason: what the scanner said versus what
 * dispatch expected, and the driver's stated reason when they proceed anyway.
 * The product never blocks on a mismatch. Blocking does not prevent bad data,
 * it manufactures it: a driver who cannot record what actually happened
 * records something else to get past the block. A recorded override with a
 * reason is better evidence than a coerced clean scan.
 *
 * All three are absent from the pod_app UPDATE grant in AppendOnlyGrants,
 * which names its columns one by one. They are fixed at insert and no later
 * code path can revise them, exactly like conflict.
 */
export class RetryTodayAndBarcodeMatch1755000000010 implements MigrationInterface {
  name = 'RetryTodayAndBarcodeMatch1755000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE delivery_attempts
         ADD COLUMN IF NOT EXISTS retry_today boolean NOT NULL DEFAULT false`,
    );
    // Nullable on purpose: null means "no expected barcode to compare against",
    // which is a different statement from false ("compared, and it differed").
    await queryRunner.query(
      `ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS barcode_match boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS barcode_override_reason text`,
    );

    // The day list asks "which stops are still live today", so the index is
    // partial on the flag rather than spanning every attempt ever recorded.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_attempts_retry_today
         ON delivery_attempts (stop_id, received_at DESC)
       WHERE retry_today`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_attempts_retry_today`);
    await queryRunner.query(
      `ALTER TABLE delivery_attempts DROP COLUMN IF EXISTS barcode_override_reason`,
    );
    await queryRunner.query(`ALTER TABLE delivery_attempts DROP COLUMN IF EXISTS barcode_match`);
    await queryRunner.query(`ALTER TABLE delivery_attempts DROP COLUMN IF EXISTS retry_today`);
  }
}
