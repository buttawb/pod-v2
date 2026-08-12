import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drivers sign in to the v1 surface by email.
 *
 * The frozen v1.4.2 contract is `POST /api/auth/login { email, password }`.
 * Our drivers only had `employee_ref`, so the real v1 body was rejected by the
 * global validation pipe with a 400 before it reached any handler: every
 * driver on the old app locked out, daily, with no refresh token to soften it.
 *
 * Backfilled deterministically from the employee reference rather than
 * invented per row, so the value is reproducible from a re-seed and obviously
 * synthetic to anyone reading the table. `.local` is reserved by RFC 6762 and
 * can never route, so a stray notification cannot reach a real inbox.
 *
 * Expand-only: the column is nullable at the database level and unique where
 * present, so this migration is safe to run while v1 is live and needs no
 * backfill window.
 */
export class DriverEmail1755000000006 implements MigrationInterface {
  name = 'DriverEmail1755000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email text`);

    await queryRunner.query(`
      UPDATE drivers
         SET email = lower(employee_ref) || '@fleet.local'
       WHERE email IS NULL
    `);

    // Case-insensitive: a handset that upper-cases the ref must not create a
    // second identity, and login lower-cases before comparing.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_drivers_email ON drivers (lower(email))
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
          GRANT UPDATE (email) ON drivers TO pod_app;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_drivers_email`);
    await queryRunner.query(`ALTER TABLE drivers DROP COLUMN IF EXISTS email`);
  }
}
