import { Injectable, MessageEvent } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Observable } from 'rxjs';
import { DataSource } from 'typeorm';
import { encodeCursor, type Keyset } from '../../common/pagination/cursor';
import { EventsBusService } from './events-bus.service';

const FEED_CATCHUP_LIMIT = 200;
const LIST_PAGE_SIZE = 50;

@Injectable()
export class OfficeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventsBus: EventsBusService,
  ) {}

  feed(cursor: Keyset | null): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let live = false;
      const buffered: MessageEvent[] = [];

      // Live events that arrive during catch-up are buffered, not dropped -
      // the gap between "replay done" and "subscription active" is where
      // naive SSE implementations silently lose events.
      const unsubscribe = this.eventsBus.subscribe((event) => {
        const message: MessageEvent = {
          id: encodeCursor({ ts: event.receivedAt, id: event.attemptId }),
          type: 'attempt',
          data: event,
        };
        if (live) subscriber.next(message);
        else buffered.push(message);
      });

      void this.catchUp(cursor)
        .then((messages) => {
          for (const m of messages) subscriber.next(m);
          for (const m of buffered) subscriber.next(m);
          live = true;
        })
        .catch((err: Error) => subscriber.error(err));

      // Comment heartbeat keeps the ALB/proxy idle timeout from severing us.
      const heartbeat = setInterval(() => {
        subscriber.next({ type: 'ping', data: '' } as MessageEvent);
      }, 25_000);

      return () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    });
  }

  private async catchUp(cursor: Keyset | null): Promise<MessageEvent[]> {
    const since = cursor ?? {
      ts: new Date(Date.now() - 60_000).toISOString(), // fresh connections start 1 min back
      id: '00000000-0000-0000-0000-000000000000',
    };
    const rows = (await this.dataSource.query(
      `SELECT id, stop_id, driver_id, outcome, evidence_status, received_at
       FROM delivery_attempts
       WHERE (received_at, id) > ($1::timestamptz, $2::uuid)
       ORDER BY received_at ASC, id ASC
       LIMIT ${FEED_CATCHUP_LIMIT}`,
      [since.ts, since.id],
    )) as Array<{
      id: string;
      stop_id: string;
      driver_id: string;
      outcome: string;
      evidence_status: string;
      received_at: Date;
    }>;

    return rows.map((r) => ({
      id: encodeCursor({ ts: new Date(r.received_at).toISOString(), id: r.id }),
      type: 'attempt',
      data: {
        attemptId: r.id,
        stopId: r.stop_id,
        driverId: r.driver_id,
        outcome: r.outcome,
        evidenceStatus: r.evidence_status,
        receivedAt: new Date(r.received_at).toISOString(),
      },
    }));
  }

  async listAttempts(cursor: Keyset | null, status?: string) {
    // The first page has no upper bound. A sentinel "maximum date" would sit
    // outside Postgres's timestamptz range, so the keyset predicate is
    // omitted entirely rather than faked.
    const rows = (await this.dataSource.query(
      `SELECT a.id, a.stop_id, a.outcome, a.evidence_status, a.note, a.captured_at,
              a.received_at, a.source, a.app_version,
              s.address, s.postcode, s.sequence,
              d.display_name AS driver_name,
              ai.status AS ai_status, ai.draft_text, ai.final_text, ai.source AS ai_source,
              ai.sent_at
       FROM delivery_attempts a
       JOIN stops s ON s.id = a.stop_id
       JOIN drivers d ON d.id = a.driver_id
       LEFT JOIN ai_summaries ai ON ai.attempt_id = a.id
       WHERE ($1::timestamptz IS NULL OR (a.received_at, a.id) < ($1::timestamptz, $2::uuid))
         AND ($3::text IS NULL OR a.outcome = $3)
       ORDER BY a.received_at DESC, a.id DESC
       LIMIT ${LIST_PAGE_SIZE}`,
      [cursor?.ts ?? null, cursor?.id ?? null, status ?? null],
    )) as Array<{ id: string; received_at: Date }>;

    const last = rows[rows.length - 1];
    return {
      attempts: rows,
      nextCursor: last
        ? encodeCursor({ ts: new Date(last.received_at).toISOString(), id: last.id })
        : null,
      hasMore: rows.length === LIST_PAGE_SIZE,
    };
  }

  async todayStats() {
    const [row] = (await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE status = 'pending')::int   AS pending,
         count(*) FILTER (WHERE status = 'attempted')::int AS attempted,
         count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
         count(*) FILTER (WHERE status = 'failed')::int    AS failed,
         count(*)::int                                     AS total
       FROM stops
       WHERE created_at >= date_trunc('day', now())`,
    )) as Array<Record<string, number>>;

    const [attempts] = (await this.dataSource.query(
      `SELECT count(*)::int AS attempts_today,
              count(*) FILTER (WHERE evidence_status = 'pending_media')::int AS pending_media
       FROM delivery_attempts
       WHERE received_at >= date_trunc('day', now())`,
    )) as Array<Record<string, number>>;

    return { stops: row, attempts };
  }
}
