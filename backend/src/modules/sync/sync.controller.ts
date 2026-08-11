import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';

const PAGE_SIZE = 500;

interface TableCursor {
  ts: string;
  id: string;
}

interface SyncCursor {
  stops: TableCursor;
  attempts: TableCursor;
}

const EPOCH: TableCursor = {
  ts: '1970-01-01 00:00:00+00',
  id: '00000000-0000-0000-0000-000000000000',
};

/**
 * Delta sync for the driver app: everything of mine that changed since my
 * cursor.
 *
 * Each table carries its OWN cursor. A single shared cursor is a data-loss
 * bug: the two queries are limited independently, so when attempts fills a
 * page ending later than the stops page, a shared cursor advances past
 * stops rows that were never sent and the client never sees them again.
 *
 * Cursor timestamps are the raw Postgres text form, not a JavaScript Date
 * round-trip. `toISOString()` truncates to milliseconds, and Postgres
 * stores microseconds: two rows inside the same millisecond would be
 * silently skipped or repeated.
 *
 * The newest edge is held back by three seconds because updated_at alone is
 * not a safe cursor - a late-committing transaction can insert a row whose
 * updated_at is EARLIER than rows the client already saw. Client merges are
 * idempotent upserts keyed on id, so re-delivery is harmless; only a missed
 * row would be a bug, and the lag window prevents that.
 */
@Roles('driver')
@Controller({ path: 'sync', version: '2' })
export class SyncController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async delta(@CurrentUser() user: JwtPayload, @Query('cursor') cursor?: string) {
    const since = cursor ? decodeSyncCursor(cursor) : { stops: EPOCH, attempts: EPOCH };
    if (cursor && !since) throw new BadRequestException('Malformed cursor');
    const from = since as SyncCursor;

    const stops = (await this.dataSource.query(
      `SELECT id, address, postcode, sequence, status, lat, lng, updated_at,
              updated_at::text AS cursor_ts
       FROM stops
       WHERE driver_id = $1
         AND (updated_at, id) > ($2::timestamptz, $3::uuid)
         AND updated_at < now() - interval '3 seconds'
       ORDER BY updated_at ASC, id ASC
       LIMIT ${PAGE_SIZE}`,
      [user.sub, from.stops.ts, from.stops.id],
    )) as Array<{ id: string; cursor_ts: string }>;

    const attempts = (await this.dataSource.query(
      `SELECT id, client_attempt_id, stop_id, outcome, evidence_status, captured_at,
              received_at, updated_at, updated_at::text AS cursor_ts
       FROM delivery_attempts
       WHERE driver_id = $1
         AND (updated_at, id) > ($2::timestamptz, $3::uuid)
         AND updated_at < now() - interval '3 seconds'
       ORDER BY updated_at ASC, id ASC
       LIMIT ${PAGE_SIZE}`,
      [user.sub, from.attempts.ts, from.attempts.id],
    )) as Array<{ id: string; cursor_ts: string }>;

    const next: SyncCursor = {
      stops: advance(from.stops, stops),
      attempts: advance(from.attempts, attempts),
    };

    return {
      stops: stops.map(stripCursor),
      attempts: attempts.map(stripCursor),
      nextCursor: encodeSyncCursor(next),
      hasMore: stops.length === PAGE_SIZE || attempts.length === PAGE_SIZE,
      serverTime: new Date().toISOString(),
    };
  }
}

/** Rows are ordered, so the last one is the furthest this table has been read. */
function advance(current: TableCursor, rows: Array<{ id: string; cursor_ts: string }>): TableCursor {
  const last = rows[rows.length - 1];
  return last ? { ts: last.cursor_ts, id: last.id } : current;
}

function stripCursor<T extends { cursor_ts?: string }>(row: T): Omit<T, 'cursor_ts'> {
  const { cursor_ts: _ignored, ...rest } = row;
  return rest;
}

export function encodeSyncCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSyncCursor(raw: string): SyncCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as SyncCursor;
    const valid = (c: TableCursor | undefined) =>
      typeof c?.ts === 'string' && typeof c?.id === 'string' && !Number.isNaN(Date.parse(c.ts));
    return valid(parsed?.stops) && valid(parsed?.attempts) ? parsed : null;
  } catch {
    return null;
  }
}
