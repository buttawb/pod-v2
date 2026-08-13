import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop an index for a sweeper that was never built.
 *
 * idx_attempts_pending_media indexes `(updated_at) WHERE evidence_status =
 * 'pending_media'` and was added for a media-completeness sweeper. That sweeper
 * is on the deliberately-not-built list, so the index has no reader.
 *
 * One query does mention the value: the office dashboard counts
 * `count(*) FILTER (WHERE evidence_status = 'pending_media')`. It cannot use
 * this index and never could. The index is keyed on updated_at while that query
 * ranges on received_at, and a FILTER inside an aggregate applies to rows
 * already read rather than choosing how to read them. Confirmed rather than
 * assumed: EXPLAIN on that query shows a Seq Scan, and pg_stat_user_indexes
 * reports idx_scan = 0 for this index against a database that has served the
 * dashboard, the day list, sync and capture.
 *
 * So it is pure write amplification: every insert into the 14M-row table
 * maintains a structure nothing reads. Keeping it would also be inconsistent
 * with saying the sweeper was cut.
 *
 * CONCURRENTLY because a plain DROP INDEX takes an ACCESS EXCLUSIVE lock on the
 * table, which is the thing the whole migration strategy exists to avoid.
 */
export class DropPendingMediaIndex1755000000014 implements MigrationInterface {
  name = 'DropPendingMediaIndex1755000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_attempts_pending_media`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreated exactly as migration 0002 defined it, so a rollback lands on
    // the same structure rather than a lookalike.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempts_pending_media
      ON delivery_attempts (updated_at)
      WHERE evidence_status = 'pending_media'
    `);
  }
}
