import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reproduces the PRE-EXISTING v1 production schema exactly as given in the
 * brief. In production this table structure already exists with ~14M pods
 * rows; this migration exists so a reviewer's fresh database starts from the
 * same point the real migration would.
 */
export class BaselineV11755000000000 implements MigrationInterface {
  name = 'BaselineV11755000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS stops (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id   uuid NOT NULL,
        address     text NOT NULL,
        postcode    text NOT NULL,
        location    varchar NOT NULL,
        sequence    int NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pods (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        stop_id       uuid NOT NULL UNIQUE,
        delivered     boolean NOT NULL,
        photo_url     text,
        signature_url text,
        location      varchar,
        note          text,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS pods');
    await queryRunner.query('DROP TABLE IF EXISTS stops');
  }
}
