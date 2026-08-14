import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
@ApiTags('sync')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'sync', version: '2' })
export class SyncController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  @ApiOperation({
    summary: 'Delta sync: everything of mine that changed since the cursor',
    description: [
      'The endpoint the handset loops on. Returns the stops and delivery attempts belonging to',
      'the signed-in driver that changed since the cursor, up to 500 rows per table per page.',
      '',
      'Precondition: a driver token. Call POST /api/v2/auth/driver/login with employeeRef',
      '"EMP-TEST-001" and password "TestDriver#2026" for the London round (151 stops), or',
      '"EMP-PK-001" with the same password for the smaller Karachi round (40 stops). Copy',
      'accessToken from the response, click Authorize at the top of this page and paste it. Both',
      'are seeded demo logins on a demo database, printed here on purpose so this page can be run',
      'during a review rather than read. They are published, not leaked. An office token gets 401',
      'Insufficient role: this route is driver-only.',
      '',
      'How to run it: leave cursor empty on the first call to read from the beginning of time.',
      'Then send back the nextCursor string from the previous response, byte for byte, and keep',
      'going while hasMore is true. Stop when hasMore is false; that is your caught-up point, and',
      'the cursor you hold is what you send next time.',
      '',
      'The cursor is opaque and should be treated that way. It is base64url JSON holding a',
      'SEPARATE (timestamp, id) position per table, because the two queries are paged',
      'independently: one shared cursor would advance past stops rows that were never sent when',
      'the attempts page happened to end later. Do not hand-craft or edit one. A cursor that does',
      'not decode is rejected with 400 rather than being quietly treated as "start from scratch",',
      'since that would silently re-download the whole round.',
      '',
      'Rows changed in the last three seconds are deliberately held back, so an attempt you just',
      'wrote via POST /api/v2/attempts will not appear until the next call. updated_at on its own',
      'is not a safe cursor: a transaction that commits late can land a row with an earlier',
      'timestamp than rows already sent, and that row would be skipped forever. Seeing a row twice',
      'is harmless because client merges are idempotent upserts keyed on id; missing one is not,',
      'so the lag window trades a little latency for that.',
      '',
      'serverTime is returned so a handset with a wrong clock can measure its own skew instead of',
      'guessing.',
    ].join('\n'),
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    example: '',
    description:
      'The nextCursor from your previous response. Leave it empty on the first call: an absent ' +
      'or empty cursor starts from the beginning of time. Opaque base64url, produced only by ' +
      'this endpoint.',
  })
  @ApiResponse({
    status: 200,
    description:
      'A page of changes. stops and attempts each hold at most 500 rows. hasMore true means at ' +
      'least one of the two tables has more waiting, so call again with nextCursor. Empty arrays ' +
      'with hasMore false means you are caught up, which is the normal steady state.',
    schema: {
      example: {
        stops: [
          {
            id: '0f5c2a91-4d7e-4b3a-9c86-5e1d8f2a4b60',
            address: '118 Ashfield Street',
            postcode: 'EC1 4TP',
            sequence: 37,
            status: 'delivered',
            lat: 51.5246,
            lng: -0.0996,
            updated_at: '2026-08-14T09:14:31.442Z',
          },
        ],
        attempts: [
          {
            id: 'e2a71c05-4f39-4d8b-9a62-31c0b7e58d14',
            client_attempt_id: '3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d',
            stop_id: '0f5c2a91-4d7e-4b3a-9c86-5e1d8f2a4b60',
            outcome: 'delivered_to_person',
            evidence_status: 'complete',
            captured_at: '2026-08-14T09:14:22.000Z',
            received_at: '2026-08-14T09:14:31.180Z',
            updated_at: '2026-08-14T09:14:31.442Z',
          },
        ],
        // A real cursor, not filler: this decodes to one {ts, id} position per
        // table, matching the two rows above. Split only to stay inside the
        // line length; it is one string.
        nextCursor:
          'eyJzdG9wcyI6eyJ0cyI6IjIwMjYtMDgtMTQgMDk6MTQ6MzEuNDQyODE3KzAwIiwiaWQiOiIwZjVjMmE5MS00' +
          'ZDdlLTRiM2EtOWM4Ni01ZTFkOGYyYTRiNjAifSwiYXR0ZW1wdHMiOnsidHMiOiIyMDI2LTA4LTE0IDA5OjE0' +
          'OjMxLjQ0MjgxNyswMCIsImlkIjoiZTJhNzFjMDUtNGYzOS00ZDhiLTlhNjItMzFjMGI3ZTU4ZDE0In19',
        hasMore: false,
        serverTime: '2026-08-14T10:41:07.912Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'The cursor did not decode, or decoded to something without a valid per-table timestamp ' +
      'and id. Refused rather than reset, because silently restarting from zero would re-send ' +
      'the entire round without anyone noticing the cursor was broken.',
  })
  @ApiResponse({
    status: 401,
    description:
      'No token, an expired token, a token minted for the v1 surface, or an office token. Role ' +
      'and audience failures both surface as 401 on this API rather than 403.',
  })
  async delta(@CurrentUser() user: JwtPayload, @Query('cursor') cursor?: string) {
    const since = cursor ? decodeSyncCursor(cursor) : { stops: EPOCH, attempts: EPOCH };
    if (cursor && !since) throw new BadRequestException('Malformed cursor');
    const from = since as SyncCursor;

    const stopRows = (await this.dataSource.query(
      `SELECT id, address, postcode, sequence, status, lat, lng, updated_at,
              updated_at::text AS cursor_ts
       FROM stops
       WHERE driver_id = $1
         AND (updated_at, id) > ($2::timestamptz, $3::uuid)
         AND updated_at < now() - interval '3 seconds'
       ORDER BY updated_at ASC, id ASC
       LIMIT ${PAGE_SIZE + 1}`,
      [user.sub, from.stops.ts, from.stops.id],
    )) as Array<{ id: string; cursor_ts: string }>;

    const attemptRows = (await this.dataSource.query(
      `SELECT id, client_attempt_id, stop_id, outcome, evidence_status, captured_at,
              received_at, updated_at, updated_at::text AS cursor_ts
       FROM delivery_attempts
       WHERE driver_id = $1
         AND (updated_at, id) > ($2::timestamptz, $3::uuid)
         AND updated_at < now() - interval '3 seconds'
       ORDER BY updated_at ASC, id ASC
       LIMIT ${PAGE_SIZE + 1}`,
      [user.sub, from.attempts.ts, from.attempts.id],
    )) as Array<{ id: string; cursor_ts: string }>;

    // One row past each page answers "is there more" exactly. Inferring it from
    // a full page tells the handset to come back for a page that is empty, and
    // this endpoint is the one the sync engine loops on.
    const moreStops = stopRows.length > PAGE_SIZE;
    const moreAttempts = attemptRows.length > PAGE_SIZE;
    const stops = moreStops ? stopRows.slice(0, PAGE_SIZE) : stopRows;
    const attempts = moreAttempts ? attemptRows.slice(0, PAGE_SIZE) : attemptRows;

    const next: SyncCursor = {
      stops: advance(from.stops, stops),
      attempts: advance(from.attempts, attempts),
    };

    return {
      stops: stops.map(stripCursor),
      attempts: attempts.map(stripCursor),
      nextCursor: encodeSyncCursor(next),
      hasMore: moreStops || moreAttempts,
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
