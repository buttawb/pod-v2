import type { EntityManager } from 'typeorm';

export const ATTEMPT_EVENTS_CHANNEL = 'attempt_events';

export interface AttemptEventPayload {
  attemptId: string;
  stopId: string;
  driverId: string;
  outcome: string;
  evidenceStatus: string;
  receivedAt: string;
}

/**
 * NOTIFY issued inside the transaction is delivered only on commit - no
 * phantom events for rolled-back writes. Payload is a slim doorbell (IDs
 * only, far under the 8KB NOTIFY limit); the table is the source of truth
 * and SSE reconnects catch up from it via Last-Event-ID.
 */
export async function notifyAttemptEvent(
  em: EntityManager,
  payload: AttemptEventPayload,
): Promise<void> {
  await em.query('SELECT pg_notify($1, $2)', [ATTEMPT_EVENTS_CHANNEL, JSON.stringify(payload)]);
}
