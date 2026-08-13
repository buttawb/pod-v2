import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The office dashboard counts today's stops, and had nothing to read it with.
 *
 * `office.service.ts` asks `WHERE created_at >= date_trunc('day', now())` with
 * no driver predicate. The only candidate index, idx_stops_driver_day, leads on
 * driver_id, so it cannot serve a query that does not filter on a driver: the
 * planner fell back to a sequential scan of the whole table on every poll.
 * Measured on the 8,010-row demo set that is 77ms and 309 buffers to return a
 * handful of counts. The shape is what matters rather than the number: the cost
 * grows with every stop the depot has ever had, not with today's.
 *
 * Btree on created_at ascending, INCLUDE (status). The range is half-open with
 * no ORDER BY so direction does not matter; carrying status is what makes this
 * worth doing. Every column the query reads then lives in the index, so
 * Postgres answers from the index alone. Measured on 208,000 stops with today
 * at 2.4% of the table, the shape production takes once a depot accumulates
 * history:
 *
 *   created_at alone     Index Scan, 4,872 buffers, WORSE than the seq scan's
 *                        4,005, because status still forced a heap visit per
 *                        row. The planner frequently declined it outright.
 *   with INCLUDE(status) Index Only Scan, Heap Fetches 0, 23 buffers, 0.586ms
 *                        against 4,005 buffers and 34.7ms for the seq scan.
 *
 * The bare index was written first and measured badly, so it is not what
 * shipped.
 *
 * CONCURRENTLY because stops is populated and the brief forbids a maintenance
 * window. Safe because the data source runs migrations with transaction mode
 * 'none'.
 */
export class StopsCreatedAtIndex1755000000012 implements MigrationInterface {
  name = 'StopsCreatedAtIndex1755000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A CONCURRENTLY build that fails part way leaves an INVALID index behind,
    // and IF NOT EXISTS would then adopt it on the next run. Drop any leftover
    // by this name first so a retry cannot inherit a half-built index.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_stops_created_at' AND NOT i.indisvalid
        ) THEN
          EXECUTE 'DROP INDEX idx_stops_created_at';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stops_created_at
      ON stops (created_at) INCLUDE (status)
    `);

    const invalid = (await queryRunner.query(`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_stops_created_at' AND NOT i.indisvalid
    `)) as Array<{ relname: string }>;
    if (invalid.length > 0) {
      throw new Error('idx_stops_created_at was built INVALID; re-run this migration');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_stops_created_at`);
  }
}
