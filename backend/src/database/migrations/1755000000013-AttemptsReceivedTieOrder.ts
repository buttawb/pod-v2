import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make the index tie-order agree with the keyset cursor's tie-order.
 *
 * idx_attempts_received was (received_at DESC, id ASC) while every reader asks
 * for `ORDER BY received_at DESC, id DESC`. Postgres can walk the index for the
 * leading column and then has to re-sort inside each timestamp group, which
 * shows up as an Incremental Sort with `Presorted Key: received_at`.
 *
 * That is cheap at demo scale only because two attempts almost never share a
 * received_at. At 14M rows with 3,000 handsets submitting concurrently, ties
 * stop being rare, and this is not merely a sort cost: `(received_at, id)` is
 * the comparison the keyset cursor pages on. If the index orders ties one way
 * and the cursor compares them the other, a page boundary that lands inside a
 * tied timestamp can repeat or skip rows, and on an evidence list a skipped row
 * is a delivery missing from its own history.
 *
 * idx_attempts_conflict, added later, already gets this right (DESC, DESC), so
 * the two indexes disagreed with each other in the same table.
 *
 * Order matters: build the replacement first, verify it, and only then drop the
 * old one, so no window exists where neither serves the query. Both statements
 * are CONCURRENTLY because delivery_attempts is the 14M-row table. On the demo
 * database this is instant; on a real one the build is online but slow, which
 * is the expected trade for not taking a lock.
 */
export class AttemptsReceivedTieOrder1755000000013 implements MigrationInterface {
  name = 'AttemptsReceivedTieOrder1755000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_attempts_received_keyset' AND NOT i.indisvalid
        ) THEN
          EXECUTE 'DROP INDEX idx_attempts_received_keyset';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempts_received_keyset
      ON delivery_attempts (received_at DESC, id DESC)
    `);

    // Verify before dropping the old index, not after. A failed build here must
    // leave the table with its original index rather than with neither.
    const invalid = (await queryRunner.query(`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_attempts_received_keyset' AND NOT i.indisvalid
    `)) as Array<{ relname: string }>;
    if (invalid.length > 0) {
      throw new Error(
        'idx_attempts_received_keyset was built INVALID; the old index is untouched, re-run this migration',
      );
    }

    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_attempts_received`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Put the original back before removing the replacement, mirroring up().
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempts_received
      ON delivery_attempts (received_at DESC, id)
    `);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_attempts_received_keyset`);
  }
}
