import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "We do not know where this happened" needs a way to be said.
 *
 * lat and lng were NOT NULL, so the app sent `lat ?? 0` when the handset had
 * no fix. That is not a missing value, it is a coordinate: 0,0 is in the Gulf
 * of Guinea, roughly 5,000 km from any delivery this fleet makes. It went into
 * an append-only evidence table that exists to support or defend a legal
 * claim, and once written it is indistinguishable from a real reading. A
 * dispute over a doorstep in Peckham should not be answered with a position
 * off the coast of Ghana stated with the same confidence as a good fix.
 *
 * A fix is genuinely unavailable often enough to matter: a basement, a
 * multi-storey car park, a lift shaft, a revoked location permission, or a
 * cold start that has not resolved by the time the driver hits Submit. The
 * honest record of those is NULL, and gps_accuracy_m is already nullable for
 * exactly the same reason.
 *
 * Existing rows are left exactly as they are. Anything already at 0,0 was
 * written as evidence, and quietly rewriting rows in an append-only table to
 * make a report look tidier is the failure this change is about. They are
 * identifiable by their coordinates and by the absence of an accuracy value.
 */
export class NullableFix1755000000007 implements MigrationInterface {
  name = 'NullableFix1755000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE delivery_attempts ALTER COLUMN lat DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE delivery_attempts ALTER COLUMN lng DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reinstating NOT NULL would fail against any row written since this ran.
    // Backfilling those to 0,0 to make the constraint pass would invent
    // coordinates for deliveries whose position was never known, so the down
    // path stops and says so rather than fabricating evidence.
    const [{ count }] = (await queryRunner.query(
      `SELECT count(*)::int AS count FROM delivery_attempts WHERE lat IS NULL OR lng IS NULL`,
    )) as Array<{ count: number }>;

    if (count > 0) {
      throw new Error(
        `Refusing to revert: ${count} attempt(s) honestly record an unknown position. ` +
          'Reverting requires inventing coordinates for them.',
      );
    }

    await queryRunner.query(`ALTER TABLE delivery_attempts ALTER COLUMN lat SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE delivery_attempts ALTER COLUMN lng SET NOT NULL`);
  }
}
