import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  AttemptSource,
  DELIVERED_OUTCOMES,
  OUTCOME_TO_STOP_STATUS,
  type Outcome,
} from '../../domain/outcomes';

interface LatestAttemptRow {
  id: string;
  outcome: Outcome;
  note: string | null;
  lat: number;
  lng: number;
  declared_photo_count: number;
  signature_s3_key: string | null;
  source: string;
  raw_payload: Record<string, unknown> | null;
  captured_at: Date;
}

/**
 * Keeps the frozen v1 `pods` table alive as a projection: "latest attempt
 * for the stop, ordered by captured_at". Application-layer (not a trigger)
 * so the mapping is unit-tested, reviewed in git, and instantly disableable
 * via DUAL_WRITE_PODS - which is the Phase 2 rollback lever.
 *
 * Ordering by captured_at matters: an offline device can submit Tuesday's
 * attempt on Thursday, after Wednesday's already arrived - the projection
 * must not regress to the late arrival.
 */
@Injectable()
export class PodsProjectionService {
  /** Updates both projections (stops.status/latest_attempt_id + pods) from the latest attempt. */
  async projectStop(em: EntityManager, stopId: string, dualWritePods: boolean): Promise<void> {
    const latest = await this.latestAttempt(em, stopId);
    if (!latest) return;

    await em.query(
      `UPDATE stops SET status = $2, latest_attempt_id = $3, updated_at = now() WHERE id = $1`,
      [stopId, OUTCOME_TO_STOP_STATUS[latest.outcome], latest.id],
    );
    if (dualWritePods) {
      await this.upsertPod(em, stopId, latest);
    }
  }

  private async latestAttempt(em: EntityManager, stopId: string): Promise<LatestAttemptRow | null> {
    const rows = (await em.query(
      `SELECT id, outcome, note, lat, lng, declared_photo_count, signature_s3_key,
              source, raw_payload, captured_at
       FROM delivery_attempts
       WHERE stop_id = $1
       -- Order by captured_at, but never let it run ahead of the server
       -- clock. A handset with a badly wrong future date would otherwise
       -- pin itself as "latest" forever and freeze the projection, so every
       -- genuine later attempt would stop updating what v1 clients see.
       -- LEAST keeps the offline case intact: a genuinely old capture
       -- submitted days late still sorts by when it was captured.
       ORDER BY LEAST(captured_at, received_at) DESC, received_at DESC
       LIMIT 1`,
      [stopId],
    )) as LatestAttemptRow[];
    return rows[0] ?? null;
  }

  private async upsertPod(em: EntityManager, stopId: string, latest: LatestAttemptRow): Promise<void> {
    const delivered = (DELIVERED_OUTCOMES as readonly string[]).includes(latest.outcome);

    // v1_compat rows carry the legacy client's own URLs - pass them through
    // untouched. v2 rows get stable authenticated URLs that 302 to a fresh
    // presigned GET (raw presigned URLs expire; public S3 URLs are banned).
    const legacyPayload = latest.source === AttemptSource.V1Compat ? latest.raw_payload : null;
    const photoUrl =
      (legacyPayload?.photo_url as string | undefined) ??
      (latest.declared_photo_count > 0 ? `/api/v2/media/attempts/${latest.id}/photo/0` : null);
    const signatureUrl =
      (legacyPayload?.signature_url as string | undefined) ??
      (latest.signature_s3_key ? `/api/v2/media/attempts/${latest.id}/signature` : null);

    await em.query(
      `INSERT INTO pods (stop_id, delivered, photo_url, signature_url, location, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stop_id) DO UPDATE SET
         delivered = EXCLUDED.delivered,
         photo_url = EXCLUDED.photo_url,
         signature_url = EXCLUDED.signature_url,
         location = EXCLUDED.location,
         note = EXCLUDED.note,
         created_at = EXCLUDED.created_at`,
      [
        stopId,
        delivered,
        photoUrl,
        signatureUrl,
        `${latest.lat},${latest.lng}`,
        latest.note,
        latest.captured_at,
      ],
    );
  }
}
