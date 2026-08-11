import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor';

const PAGE_SIZE = 500;

/**
 * Delta sync for the driver app: everything of mine that changed since my
 * cursor. Keyset on (updated_at, id); the newest edge is served with a
 * 3-second safety lag because updated_at alone is not a safe cursor - a
 * late-committing transaction can insert a row with an updated_at EARLIER
 * than rows a client already saw. The client merge is an idempotent upsert
 * keyed on id, so re-delivery is harmless; only missed rows would be a bug,
 * and the lag window prevents that.
 */
@Roles('driver')
@Controller({ path: 'sync', version: '2' })
export class SyncController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async delta(@CurrentUser() user: JwtPayload, @Query('cursor') cursor?: string) {
    const keyset = cursor ? decodeCursor(cursor) : null;
    if (cursor && !keyset) throw new BadRequestException('Malformed cursor');

    const since = keyset ?? { ts: new Date(0).toISOString(), id: '00000000-0000-0000-0000-000000000000' };

    const stops = (await this.dataSource.query(
      `SELECT id, address, postcode, sequence, status, lat, lng, updated_at
       FROM stops
       WHERE driver_id = $1
         AND (updated_at, id) > ($2::timestamptz, $3::uuid)
         AND updated_at < now() - interval '3 seconds'
       ORDER BY updated_at ASC, id ASC
       LIMIT ${PAGE_SIZE}`,
      [user.sub, since.ts, since.id],
    )) as Array<{ updated_at: Date; id: string }>;

    const attempts = (await this.dataSource.query(
      `SELECT id, client_attempt_id, stop_id, outcome, evidence_status, captured_at,
              received_at, updated_at
       FROM delivery_attempts
       WHERE driver_id = $1
         AND (updated_at, id) > ($2::timestamptz, $3::uuid)
         AND updated_at < now() - interval '3 seconds'
       ORDER BY updated_at ASC, id ASC
       LIMIT ${PAGE_SIZE}`,
      [user.sub, since.ts, since.id],
    )) as Array<{ updated_at: Date; id: string }>;

    const rows = [...stops, ...attempts];
    const last = rows.reduce<{ ts: string; id: string } | null>((acc, row) => {
      const ts = new Date(row.updated_at).toISOString();
      if (!acc || ts > acc.ts || (ts === acc.ts && row.id > acc.id)) return { ts, id: row.id };
      return acc;
    }, keyset);

    return {
      stops,
      attempts,
      nextCursor: last ? encodeCursor(last) : cursor ?? null,
      hasMore: stops.length === PAGE_SIZE || attempts.length === PAGE_SIZE,
      serverTime: new Date().toISOString(),
    };
  }
}
