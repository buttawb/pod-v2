import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What dispatch expected at the door, and a record of every erasure performed.
 *
 * stops.expected_barcode is additive on the v1 table. The legacy serializer is
 * a field whitelist rather than SELECT *, so this cannot reach the frozen v1
 * response by accident; the golden-file test is what proves that stays true.
 *
 * erasure_log exists because an erasure that leaves no trace is its own
 * compliance problem. Answering "was this person's data erased, by whom, and
 * what exactly was cleared" is part of demonstrating the erasure happened, and
 * a redaction with nothing recording it is indistinguishable from data that
 * was never held.
 *
 * The log is append-only in the strongest sense available: pod_app is granted
 * SELECT and INSERT and nothing else, so the runtime role cannot revise or
 * delete an entry even if application code regresses. It deliberately holds no
 * copy of the values that were redacted, only the field names. A log that
 * quoted the old email address would reinstate the personal data the erasure
 * was carried out to remove.
 */
export class ExpectedBarcodeAndErasureLog1755000000011 implements MigrationInterface {
  name = 'ExpectedBarcodeAndErasureLog1755000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE stops ADD COLUMN IF NOT EXISTS expected_barcode text`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS erasure_log (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id      uuid NOT NULL,
        subject_type  text NOT NULL CHECK (subject_type IN ('driver','office_user')),
        subject_id    uuid NOT NULL,
        fields_redacted jsonb NOT NULL,
        tokens_revoked  integer NOT NULL DEFAULT 0,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_erasure_log_subject
         ON erasure_log (subject_type, subject_id, created_at DESC)`,
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
          -- No UPDATE and no DELETE, by omission and on purpose.
          GRANT SELECT, INSERT ON erasure_log TO pod_app;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS erasure_log`);
    await queryRunner.query(`ALTER TABLE stops DROP COLUMN IF EXISTS expected_barcode`);
  }
}
