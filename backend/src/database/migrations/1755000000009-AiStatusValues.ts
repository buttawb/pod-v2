import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets an AI summary actually be `failed` or `approved`.
 *
 * Those two values were added to AiSummaryStatus in code, and markSent was
 * changed to write `approved`, but the CHECK constraint from ExpandV2 still
 * only permitted ('pending','ready','fallback'). The entity comment claimed a
 * plain text column meant a new value needed no migration, which was true of
 * the column type and false of the constraint sitting on it.
 *
 * The visible effect was a 500 on POST /api/v2/office/attempts/:id/summary/send:
 * a named human clicking Send got an internal error, and nothing recorded that
 * they had approved the text. Checked against the deployed API before writing
 * this, so it is a fixed defect rather than a hypothetical one.
 *
 * The constraint is kept rather than dropped. It is the thing that would have
 * caught a typo'd status, and the fix is to widen it to the set the code
 * actually uses, not to stop checking.
 */
export class AiStatusValues1755000000009 implements MigrationInterface {
  name = 'AiStatusValues1755000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ai_summaries DROP CONSTRAINT IF EXISTS chk_ai_status`);
    await queryRunner.query(
      `ALTER TABLE ai_summaries ADD CONSTRAINT chk_ai_status
         CHECK (status IN ('pending','ready','fallback','failed','approved'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rows written under the wider set would violate the narrow one, so they
    // are folded back to their nearest legal meaning rather than blocking the
    // revert: an approved summary is still a summary that was ready to send,
    // and a failed generation is the case the template fallback exists for.
    await queryRunner.query(`UPDATE ai_summaries SET status = 'ready' WHERE status = 'approved'`);
    await queryRunner.query(`UPDATE ai_summaries SET status = 'fallback' WHERE status = 'failed'`);
    await queryRunner.query(`ALTER TABLE ai_summaries DROP CONSTRAINT IF EXISTS chk_ai_status`);
    await queryRunner.query(
      `ALTER TABLE ai_summaries ADD CONSTRAINT chk_ai_status
         CHECK (status IN ('pending','ready','fallback'))`,
    );
  }
}
