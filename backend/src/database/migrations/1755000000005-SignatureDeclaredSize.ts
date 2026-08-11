import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The declared signature size has to be remembered separately from the
 * verified one.
 *
 * Presigned PUTs pin Content-Length, so re-issuing a signature URL from the
 * upload-urls endpoint has to sign the size the client actually declared.
 * Reading it from signature_size_bytes could not work: that column only
 * gets a value once S3 has been checked at finalize, which is precisely
 * after the upload we are trying to enable. The fallback guess signed a
 * length the client would never send, so every re-issued signature upload
 * was rejected by S3.
 */
export class SignatureDeclaredSize1755000000005 implements MigrationInterface {
  name = 'SignatureDeclaredSize1755000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE delivery_attempts
        ADD COLUMN IF NOT EXISTS signature_declared_size_bytes bigint
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
          GRANT UPDATE (signature_declared_size_bytes) ON delivery_attempts TO pod_app;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE delivery_attempts DROP COLUMN IF EXISTS signature_declared_size_bytes',
    );
  }
}
