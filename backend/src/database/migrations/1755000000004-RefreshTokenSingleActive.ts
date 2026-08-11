import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Database-level backstop for the refresh-rotation invariant: at most ONE
 * active token per family. The application already elects a single rotator
 * via conditioned UPDATEs, but a partial unique index makes a double-mint
 * impossible rather than merely unlikely - and a family with two live
 * tokens would silently disable reuse/theft detection for that driver.
 */
export class RefreshTokenSingleActive1755000000004 implements MigrationInterface {
  name = 'RefreshTokenSingleActive1755000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_refresh_tokens_one_active_per_family
      ON refresh_tokens (family_id)
      WHERE status = 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX CONCURRENTLY IF EXISTS uq_refresh_tokens_one_active_per_family',
    );
  }
}
