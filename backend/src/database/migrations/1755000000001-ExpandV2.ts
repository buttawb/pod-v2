import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EXPAND phase - additive only. Nothing here is visible to v1 clients:
 * new tables, plus nullable/defaulted columns on stops (metadata-only in
 * PG11+, no table rewrite at any row count). Runs against live traffic.
 */
export class ExpandV21755000000001 implements MigrationInterface {
  name = 'ExpandV21755000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_ref  text NOT NULL UNIQUE,
        display_name  text NOT NULL,
        password_hash text NOT NULL,
        is_active     boolean NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        device_fingerprint    text NOT NULL UNIQUE,
        platform              text NOT NULL DEFAULT 'android',
        last_seen_app_version text,
        first_seen_at         timestamptz NOT NULL DEFAULT now(),
        last_seen_at          timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS office_users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text NOT NULL UNIQUE,
        display_name  text NOT NULL,
        password_hash text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash     text NOT NULL,
        family_id      uuid NOT NULL,
        driver_id      uuid REFERENCES drivers(id),
        office_user_id uuid REFERENCES office_users(id),
        device_id      uuid REFERENCES devices(id),
        status         text NOT NULL DEFAULT 'active'
                       CONSTRAINT chk_refresh_status CHECK (status IN ('active','rotated','revoked')),
        rotated_at     timestamptz,
        successor_id   uuid,
        expires_at     timestamptz NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_refresh_owner CHECK (num_nonnulls(driver_id, office_user_id) = 1)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_refresh_tokens_hash ON refresh_tokens (token_hash)`,
    );

    // The evidence table. TEXT + CHECK over native enums: constraint swaps
    // (DROP/ADD NOT VALID/VALIDATE) are online; ALTER TYPE ADD VALUE is not
    // transactional and enum values can never be dropped.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_attempt_id      uuid NOT NULL,
        stop_id                uuid NOT NULL REFERENCES stops(id),
        driver_id              uuid NOT NULL REFERENCES drivers(id),
        device_id              uuid REFERENCES devices(id),
        parcel_barcode         text,
        barcode_source         text
                               CONSTRAINT chk_attempts_barcode_source
                               CHECK (barcode_source IS NULL OR barcode_source IN ('scanned','manual')),
        outcome                text NOT NULL
                               CONSTRAINT chk_attempts_outcome CHECK (outcome IN (
                                 'delivered_to_person','left_with_neighbour','left_safe_place',
                                 'no_answer_carded','refused','access_failure')),
        signature_s3_key       text,
        signature_verified_at  timestamptz,
        signature_size_bytes   bigint,
        neighbour_house_number text,
        reason_code            text,
        note                   text,
        lat                    double precision NOT NULL
                               CONSTRAINT chk_attempts_lat CHECK (lat BETWEEN -90 AND 90),
        lng                    double precision NOT NULL
                               CONSTRAINT chk_attempts_lng CHECK (lng BETWEEN -180 AND 180),
        gps_accuracy_m         real,
        captured_at            timestamptz NOT NULL,
        received_at            timestamptz NOT NULL DEFAULT now(),
        clock_suspect          boolean NOT NULL DEFAULT false,
        app_version            text NOT NULL,
        source                 text NOT NULL DEFAULT 'v2'
                               CONSTRAINT chk_attempts_source
                               CHECK (source IN ('v2','v1_compat','backfill')),
        raw_payload            jsonb,
        declared_photo_count   smallint NOT NULL DEFAULT 0
                               CONSTRAINT chk_attempts_photo_count
                               CHECK (declared_photo_count BETWEEN 0 AND 4),
        evidence_status        text NOT NULL DEFAULT 'pending_media'
                               CONSTRAINT chk_attempts_evidence_status
                               CHECK (evidence_status IN ('pending_media','complete','incomplete_expired')),
        payload_hash           text NOT NULL,
        updated_at             timestamptz NOT NULL DEFAULT now(),
        -- Belt-and-braces for the non-negotiable evidence rules; the full
        -- matrix lives in code (src/domain/outcomes.ts).
        CONSTRAINT chk_neighbour_evidence CHECK (
          outcome <> 'left_with_neighbour' OR neighbour_house_number IS NOT NULL),
        CONSTRAINT chk_failure_reason CHECK (
          outcome NOT IN ('refused','access_failure') OR reason_code IS NOT NULL)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS attempt_photos (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        attempt_id          uuid NOT NULL REFERENCES delivery_attempts(id),
        photo_index         smallint NOT NULL
                            CONSTRAINT chk_photo_index CHECK (photo_index BETWEEN 0 AND 3),
        s3_key              text NOT NULL,
        content_type        text NOT NULL DEFAULT 'image/jpeg',
        declared_size_bytes bigint,
        size_bytes          bigint,
        etag                text,
        status              text NOT NULL DEFAULT 'awaiting_upload'
                            CONSTRAINT chk_photo_status
                            CHECK (status IN ('awaiting_upload','verified','deleted_retention')),
        verified_at         timestamptz,
        created_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_attempt_photos_attempt_index UNIQUE (attempt_id, photo_index)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_summaries (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        attempt_id     uuid NOT NULL UNIQUE REFERENCES delivery_attempts(id),
        status         text NOT NULL DEFAULT 'pending'
                       CONSTRAINT chk_ai_status CHECK (status IN ('pending','ready','fallback')),
        draft_text     text,
        source         text
                       CONSTRAINT chk_ai_source CHECK (source IS NULL OR source IN ('bedrock','template')),
        model          text,
        prompt_version text,
        input_tokens   int,
        output_tokens  int,
        est_cost_usd   numeric(10,6),
        generated_at   timestamptz,
        final_text     text,
        edited_by      uuid REFERENCES office_users(id),
        edited_at      timestamptz,
        sent_at        timestamptz
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_summary_cache (
        cache_key    char(64) PRIMARY KEY,
        summary_text text NOT NULL,
        model        text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS backfill_progress (
        job_id          text PRIMARY KEY,
        last_created_at timestamptz,
        last_id         uuid,
        rows_done       bigint NOT NULL DEFAULT 0,
        updated_at      timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Additive columns on stops. Constant defaults are metadata-only in
    // PG11+ - no rewrite of the 14M-row table, no lock beyond a brief
    // ACCESS EXCLUSIVE for the catalog change.
    await queryRunner.query(`
      ALTER TABLE stops
        ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'
          CONSTRAINT chk_stops_status
          CHECK (status IN ('pending','attempted','delivered','failed')),
        ADD COLUMN IF NOT EXISTS latest_attempt_id uuid,
        ADD COLUMN IF NOT EXISTS lat double precision,
        ADD COLUMN IF NOT EXISTS lng double precision,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stops
        DROP COLUMN IF EXISTS updated_at,
        DROP COLUMN IF EXISTS lng,
        DROP COLUMN IF EXISTS lat,
        DROP COLUMN IF EXISTS latest_attempt_id,
        DROP COLUMN IF EXISTS status
    `);
    await queryRunner.query('DROP TABLE IF EXISTS backfill_progress');
    await queryRunner.query('DROP TABLE IF EXISTS ai_summary_cache');
    await queryRunner.query('DROP TABLE IF EXISTS ai_summaries');
    await queryRunner.query('DROP TABLE IF EXISTS attempt_photos');
    await queryRunner.query('DROP TABLE IF EXISTS delivery_attempts');
    await queryRunner.query('DROP TABLE IF EXISTS refresh_tokens');
    await queryRunner.query('DROP TABLE IF EXISTS office_users');
    await queryRunner.query('DROP TABLE IF EXISTS devices');
    await queryRunner.query('DROP TABLE IF EXISTS drivers');
  }
}
