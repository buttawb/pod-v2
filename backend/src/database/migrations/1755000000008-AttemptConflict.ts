import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records that an attempt arrived for a stop its driver no longer owns.
 *
 * Dispatch reassigns a stop while the driver who had it is offline. That
 * driver has already been to the door, taken the photo and the signature, and
 * driven on. When the handset finds signal, the write used to be refused with
 * a 403 and the app parked it as needs_attention. The delivery happened; the
 * only record of it sat on a phone until someone noticed.
 *
 * Rejecting a completed delivery because the paperwork moved is the wrong
 * trade for an evidence system. The attempt is accepted, attributed to the
 * driver who actually made it, and flagged so the office sees it rather than
 * finding out from a customer.
 *
 * Deliberately NOT in the pod_app UPDATE grant. The grant in
 * AppendOnlyGrants names its columns one by one and these are not among them,
 * so the flag is fixed at insert and no later code path can quietly clear it.
 * A conflict is resolved by acting on the stop, not by editing the evidence.
 */
export class AttemptConflict1755000000008 implements MigrationInterface {
  name = 'AttemptConflict1755000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS conflict boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS conflict_reason text`,
    );

    // Partial: conflicts are rare by design, so the office queue should not
    // pay to scan an index over every attempt ever recorded.
    //
    // CONCURRENTLY because this lands on delivery_attempts, the table the whole
    // design treats as 14M rows. A plain CREATE INDEX holds a lock that blocks
    // writes for the length of the build, and "no maintenance window" is a
    // constraint here rather than a preference. Safe because the data source
    // runs migrations with transaction mode 'none'; this migration and 0010
    // were both missing it.
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempts_conflict
         ON delivery_attempts (received_at DESC, id DESC)
       WHERE conflict`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_attempts_conflict`);
    await queryRunner.query(`ALTER TABLE delivery_attempts DROP COLUMN IF EXISTS conflict_reason`);
    await queryRunner.query(`ALTER TABLE delivery_attempts DROP COLUMN IF EXISTS conflict`);
  }
}
