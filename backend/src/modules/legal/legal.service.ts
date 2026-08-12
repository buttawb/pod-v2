import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshTokenStatus } from '../auth/entities/refresh-token.entity';

export const SubjectType = {
  Driver: 'driver',
  OfficeUser: 'office_user',
} as const;

export type SubjectType = (typeof SubjectType)[keyof typeof SubjectType];

/**
 * Which columns an erasure clears, per subject, and what replaces each value.
 *
 * A list rather than a loop over the entity, because the point of this file is
 * that the boundary is explicit. A column added to `drivers` tomorrow should
 * not silently start being erased, and a column added that *is* personal data
 * should fail review here rather than be forgotten.
 *
 * `employee_ref` is not on this list: it is the payroll key that ties an
 * attempt to the person who made it, so clearing it would break the
 * attribution of evidence we are required to keep. `password_hash` is not
 * either; the token revocation below is what ends access.
 *
 * NULL is the honest erasure and is used wherever the column permits it.
 * `display_name` is NOT NULL on both tables and `office_users.email` is both
 * NOT NULL and UNIQUE, so those get a placeholder instead. The placeholder is
 * chosen to carry no information about the person: a fixed marker where it can
 * be, and where uniqueness is required, the row's own primary key, which the
 * table already holds. `.invalid` is reserved by RFC 2606 and can never route,
 * so an erased address cannot be mistaken for a live one or mailed by accident.
 *
 * Relaxing the NOT NULL constraints instead was the alternative. Not worth it:
 * every read path would have to start handling a null display name to make one
 * write simpler, and a name that reads "[erased]" states plainly what happened
 * where a null would just look like missing data.
 */
type Redaction = { column: string; value: (subjectId: string) => string | null };

const REDACTABLE: Record<SubjectType, { table: string; columns: Redaction[] }> = {
  [SubjectType.Driver]: {
    table: 'drivers',
    columns: [
      { column: 'email', value: () => null },
      { column: 'display_name', value: () => '[erased]' },
    ],
  },
  [SubjectType.OfficeUser]: {
    table: 'office_users',
    columns: [
      { column: 'email', value: (id) => `erased-${id}@erased.invalid` },
      { column: 'display_name', value: () => '[erased]' },
    ],
  },
};

export interface ErasureResult {
  subjectType: SubjectType;
  subjectId: string;
  fieldsRedacted: string[];
  tokensRevoked: number;
  evidenceRetained: number;
  erasedAt: string;
}

@Injectable()
export class LegalService {
  private readonly logger = new Logger(LegalService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Erases a subject's contact data and ends their sessions.
   *
   * ============================================================
   * WHAT THIS DELIBERATELY DOES NOT TOUCH
   * ============================================================
   * `delivery_attempts` and `attempt_photos` are structurally excluded. They
   * are proof of delivery: records kept for the establishment, exercise or
   * defence of legal claims, which UK GDPR Article 17(3)(e) exempts from the
   * right to erasure for as long as that purpose lasts. Here that is six
   * years, the limitation period for a contractual claim, enforced by the S3
   * lifecycle rule rather than by anything in this process, so it holds even
   * if this code is never called again.
   *
   * The exclusion is structural rather than a filter someone could widen: the
   * runtime role holds no DELETE on either table and its UPDATE grant names
   * four bookkeeping columns one by one, so this service physically cannot
   * redact an attempt even if a future change asked it to. A driver's name is
   * erasable; the fact that a parcel was delivered to a given address at a
   * given time is not, until the claims window closes and the objects expire
   * on their own.
   *
   * The erasure is logged. An erasure nobody can evidence is its own
   * compliance problem: "was this person's data erased, by whom, and what was
   * cleared" has to be answerable afterwards. The log records field names and
   * never values, because a log quoting the old email address would reinstate
   * the data the erasure removed.
   */
  async erase(
    actorId: string,
    subjectType: SubjectType,
    subjectId: string,
    confirm: boolean,
  ): Promise<ErasureResult> {
    if (!confirm) {
      throw new BadRequestException(
        'Erasure is irreversible and must be confirmed explicitly: send confirm: true',
      );
    }

    const spec = REDACTABLE[subjectType];
    if (!spec) throw new BadRequestException('Unknown subject type');

    return this.dataSource.transaction(async (em) => {
      const fieldNames = spec.columns.map((c) => c.column);

      const [subject] = (await em.query(
        `SELECT id FROM ${spec.table} WHERE id = $1 FOR UPDATE`,
        [subjectId],
      )) as Array<{ id: string }>;
      if (!subject) throw new NotFoundException(`Unknown ${subjectType}`);

      // Redacted in place. The row survives so evidence keeps its foreign key
      // and its attribution; only what identifies the person is removed.
      const setters = spec.columns.map((c, i) => `${c.column} = $${i + 2}`).join(', ');
      await em.query(`UPDATE ${spec.table} SET ${setters} WHERE id = $1`, [
        subjectId,
        ...spec.columns.map((c) => c.value(subjectId)),
      ]);

      const column = subjectType === SubjectType.Driver ? 'driver_id' : 'office_user_id';
      const revoked = (await em.query(
        `UPDATE refresh_tokens SET status = $2
          WHERE ${column} = $1 AND status <> $2
          RETURNING id`,
        [subjectId, RefreshTokenStatus.Revoked],
      )) as Array<{ id: string }>;

      // Counted, not touched. Reporting how much evidence was retained is part
      // of an honest answer to an erasure request.
      const retained =
        subjectType === SubjectType.Driver
          ? ((await em.query(
              `SELECT count(*)::int AS n FROM delivery_attempts WHERE driver_id = $1`,
              [subjectId],
            )) as Array<{ n: number }>)[0].n
          : 0;

      await em.query(
        `INSERT INTO erasure_log (actor_id, subject_type, subject_id, fields_redacted, tokens_revoked)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [actorId, subjectType, subjectId, JSON.stringify(fieldNames), revoked.length],
      );

      this.logger.log(
        JSON.stringify({
          event: 'erasure',
          actorId,
          subjectType,
          subjectId,
          fieldsRedacted: fieldNames,
          tokensRevoked: revoked.length,
          evidenceRetained: retained,
        }),
      );

      return {
        subjectType,
        subjectId,
        fieldsRedacted: fieldNames,
        tokensRevoked: revoked.length,
        evidenceRetained: retained,
        erasedAt: new Date().toISOString(),
      };
    });
  }
}
