import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * All hot-path indexes, built CONCURRENTLY so live traffic on the 14M-row
 * tables never blocks. This is why the data source runs migrations with
 * transaction mode 'none' - CIC cannot run inside a transaction block.
 * IF NOT EXISTS makes a re-run after any partial failure safe.
 */
export class IndexesConcurrently1755000000002 implements MigrationInterface {
  name = 'IndexesConcurrently1755000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotency arbiter - THE serialization point across LB instances.
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_attempts_client_attempt_id
      ON delivery_attempts (client_attempt_id)
    `);

    // Driver's today list.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stops_driver_day
      ON stops (driver_id, created_at DESC, sequence)
    `);

    // Evidence timeline for one stop.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempts_stop
      ON delivery_attempts (stop_id, captured_at DESC)
    `);

    // Delta-sync keysets (driver app catch-up).
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempts_driver_updated
      ON delivery_attempts (driver_id, updated_at, id)
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stops_driver_updated
      ON stops (driver_id, updated_at, id)
    `);

    // Office live-feed catch-up (SSE Last-Event-ID replay).
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempts_received
      ON delivery_attempts (received_at DESC, id)
    `);

    // Depot map bounding box - built-in point + GiST, no PostGIS needed.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stops_geo
      ON stops USING gist (point(lng, lat))
      WHERE lat IS NOT NULL
    `);

    // Media-completeness sweeper (tiny partial index).
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempts_pending_media
      ON delivery_attempts (updated_at)
      WHERE evidence_status = 'pending_media'
    `);

    // Legacy read path: pods.stop_id already has a unique index from v1.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const idx of [
      'idx_attempts_pending_media',
      'idx_stops_geo',
      'idx_attempts_received',
      'idx_stops_driver_updated',
      'idx_attempts_driver_updated',
      'idx_attempts_stop',
      'idx_stops_driver_day',
      'uq_attempts_client_attempt_id',
    ]) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx}`);
    }
  }
}
