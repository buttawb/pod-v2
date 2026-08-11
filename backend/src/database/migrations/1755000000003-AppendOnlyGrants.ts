import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Belt-and-braces immutability: even if application code regresses, the
 * runtime role (pod_app) physically cannot UPDATE or DELETE evidence.
 * Column-level grants allow exactly the two bookkeeping columns to move.
 *
 * The pod_app role itself is created by infra (docker-entrypoint init SQL),
 * never by a migration - migrations must not contain credentials. This
 * migration is a no-op on databases without the role (local quick-start).
 */
export class AppendOnlyGrants1755000000003 implements MigrationInterface {
  name = 'AppendOnlyGrants1755000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
          GRANT USAGE ON SCHEMA public TO pod_app;

          -- Evidence: append-only. No UPDATE (except bookkeeping), no DELETE, ever.
          GRANT SELECT, INSERT ON delivery_attempts TO pod_app;
          GRANT UPDATE (evidence_status, updated_at, signature_verified_at, signature_size_bytes)
            ON delivery_attempts TO pod_app;

          -- Manifest: verification bookkeeping only; s3_key/attempt_id immutable.
          GRANT SELECT, INSERT ON attempt_photos TO pod_app;
          GRANT UPDATE (status, size_bytes, etag, verified_at) ON attempt_photos TO pod_app;

          -- Mutable operational tables (still no DELETE - retention runs as owner).
          GRANT SELECT, INSERT, UPDATE ON stops, pods, drivers, devices, office_users,
            refresh_tokens, ai_summaries, ai_summary_cache, backfill_progress TO pod_app;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
          REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pod_app;
        END IF;
      END $$;
    `);
  }
}
