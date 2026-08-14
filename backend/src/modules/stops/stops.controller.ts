import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { StopsService, type DepotBbox } from './stops.service';

@Roles('driver')
@ApiTags('stops')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'stops', version: '2' })
export class StopsController {
  constructor(private readonly stopsService: StopsService) {}

  /** Today's route, in planned sequence - the app's offline cache source. */
  @Get()
  @ApiOperation({
    summary: "Today's round for the signed-in driver",
    description: [
      'Start here after logging in. This is where every stop id on this page comes from:',
      'take any `id` from the response and paste it into GET /api/v2/stops/{id},',
      'POST /api/v2/attempts, or anywhere else a `stopId` is asked for.',
      '',
      'How to run it: sign in with POST /api/v2/auth/driver/login, copy `accessToken` from',
      'that response, press the green **Authorize** button at the top of this page and paste',
      'it in. Then press *Try it out* and *Execute* here. There is no body and no parameter.',
      '',
      'The credentials in the login example are demo ones we publish on purpose so this page',
      'can be executed during review. They open seeded accounts on a demo database and are',
      'not a leaked secret.',
      '',
      'The round is scoped two ways: to the driver the token belongs to, and to stops created',
      'today. On the seeded demo data `EMP-TEST-001` has a London round of 151 stops and',
      '`EMP-PK-001` has a Karachi round of 40, with the front of each already worked so the',
      'list opens on a day in progress. Stops come back in planned `sequence` order, which is',
      'what lets the handset cache the response and work through it offline.',
      '',
      '`live_today` is derived, not stored: false once a stop is delivered or failed, true',
      'while it is still pending, and otherwise taken from the `retryToday` flag on the most',
      'recent attempt. It answers "is this still my work today?", which `status` alone cannot,',
      'because `status` is shared with the frozen v1 surface and only has four values.',
      '',
      '`serverTime` is the server clock at the moment of the read. The app compares it with',
      'its own clock so a handset with a wrong date does not stamp evidence with a wrong time.',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description:
      "The driver's stops for today in sequence order, plus the server clock.",
    schema: {
      example: {
        stops: [
          {
            id: '28e634ba-ef89-4fcd-b21a-e9881367f757',
            address: '42 Church Road',
            postcode: 'E2 4QN',
            location: '51.5296,-0.0567',
            sequence: 1,
            status: 'delivered',
            lat: 51.5296,
            lng: -0.0567,
            updated_at: '2026-08-14T09:12:03.144Z',
            expected_barcode: 'JD0413882910',
            live_today: false,
          },
          {
            id: '8b21f0ac-4e77-45d1-8c6e-6f0a1d3b5c92',
            address: '117 Station Road',
            postcode: 'SE15 3PL',
            location: '51.4713,-0.0644',
            sequence: 2,
            status: 'pending',
            lat: 51.4713,
            lng: -0.0644,
            updated_at: '2026-08-14T06:00:00.000Z',
            expected_barcode: 'JD9920174455',
            live_today: true,
          },
        ],
        serverTime: '2026-08-14T09:41:55.902Z',
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: [
      'No bearer token, an expired one, a token minted for the frozen v1 surface, or an',
      'office token. This route is driver-only, and the guard reports a role mismatch as 401',
      'rather than 403.',
    ].join(' '),
  })
  today(@CurrentUser() user: JwtPayload) {
    return this.stopsService.todayForDriver(user.sub);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One stop with its full attempt history',
    description: [
      'Everything recorded against a single stop: the address block the driver sees, then',
      'every delivery attempt newest first, each with its outcome, reason, evidence status',
      'and the index and status of each photograph.',
      '',
      'The `id` box below is pre-filled with a real stop on the seeded London round, so this',
      'runs unedited once you are authorized. Sign in first with POST /api/v2/auth/driver/login',
      'and paste the returned `accessToken` into Authorize at the top of the page. To look at a',
      'different stop, take any `id` from GET /api/v2/stops.',
      '',
      'Only the driver who owns the stop can read it. Photograph bytes are not here: the',
      'response carries each photo index and status, and the image itself is fetched through',
      'the media endpoints under a short-lived URL.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description:
      'Stop UUID. The example is a real stop on the seeded London round and resolves as written. Any id from GET /api/v2/stops works, which is where to go if the demo database is ever fully reseeded.',
    example: '28e634ba-ef89-4fcd-b21a-e9881367f757',
  })
  @ApiResponse({
    status: 200,
    description: 'The stop and its attempts, newest attempt first.',
    schema: {
      example: {
        stop: {
          id: '28e634ba-ef89-4fcd-b21a-e9881367f757',
          address: '42 Church Road',
          postcode: 'E2 4QN',
          sequence: 1,
          status: 'delivered',
          lat: 51.5296,
          lng: -0.0567,
        },
        attempts: [
          {
            id: 'c0d9a2f4-1b58-4a3e-9d77-0f2c6b8e4a10',
            clientAttemptId: '9f8e7d6c-5b4a-4392-8171-0a1b2c3d4e5f',
            outcome: 'left_safe_place',
            reasonCode: null,
            note: 'Left in the porch, out of sight from the street',
            capturedAt: '2026-08-14T09:11:40.000Z',
            receivedAt: '2026-08-14T09:12:03.144Z',
            evidenceStatus: 'complete',
            source: 'v2',
            photos: [{ index: 0, status: 'verified' }],
            hasSignature: false,
          },
        ],
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'The `id` in the path is not a UUID.',
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing, expired or wrong-surface token, or the token is not a driver token.',
  })
  @ApiResponse({
    status: 403,
    description:
      "The stop exists but belongs to another driver. A driver may only read their own round, so this is deliberately distinct from 404: it does not confirm anything about the stop's contents.",
  })
  @ApiResponse({
    status: 404,
    description:
      'No stop with that id. Most often a stale id from a database that has been reseeded.',
  })
  detail(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) stopId: string,
  ) {
    return this.stopsService.detailForDriver(user.sub, stopId);
  }
}

@Roles('driver', 'office')
@ApiTags('stops')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'depot', version: '2' })
export class DepotController {
  constructor(private readonly stopsService: StopsService) {}

  /**
   * The depot-overview map payload: every stop as a minimal GeoJSON feature
   * ({id, s: status code} - no addresses, names, or driver identity; the map
   * does not need personal data). ~5,000 features fetched once per screen
   * mount and rendered as a single GPU source.
   *
   * Fleet-wide visibility is the brief's requirement ("all ~5,000 stops for
   * the depot's coverage area on one map"), so a driver legitimately sees
   * other drivers' stops here. Drivers are pinned to TODAY's working set:
   * arbitrary dates would turn a live operational map into a historical
   * movement archive, which the product never asks for. Office users, who
   * already have per-attempt access, may request any date.
   */
  @Get('stops.geojson')
  @ApiOperation({
    summary: 'Depot coverage map as GeoJSON, clustered or point-by-point',
    description: [
      'The whole depot on one map. Every stop in the day is returned as a GeoJSON feature so',
      'a client can hand the response straight to a map library as a single source.',
      '',
      'How to run it: sign in as either a driver (POST /api/v2/auth/driver/login) or the',
      'office (POST /api/v2/auth/office/login), authorize with the returned `accessToken`,',
      'then press *Try it out* and *Execute*. The boxes come prefilled with a London viewport',
      'that returns data on either token, and every parameter is optional, so clearing them all',
      'is also valid and returns the whole working set. The demo logins are published',
      'deliberately for this review: they are seeded accounts on a throwaway database, not',
      'real ones.',
      '',
      'Two response shapes, chosen by `zoom`:',
      '',
      '- Below zoom 13 the server aggregates into a grid and returns `mode: "clustered"`.',
      '  Each feature is one cell with a `point_count`, at most 400 cells. At that distance a',
      '  viewport covers a city or a country, individual pins are unreadable, and only the',
      '  shape of the work matters. The cell shrinks as you zoom in.',
      '- At zoom 13 or above the server returns `mode: "points"`, one feature per stop, capped',
      '  at 1500. If the viewport held more, `truncated` comes back true so the client can',
      '  tell the operator to zoom in rather than trust an incomplete map.',
      '- Omitting `zoom` entirely means "give me the working set": all points, no cap and no',
      '  clustering. That is what the office dashboard asks for, since a desktop renders about',
      '  5,000 stops happily and clusters them itself.',
      '',
      'Feature properties are only `id` and `s` (the status code: 0 pending, 1 attempted,',
      '2 delivered, 3 failed). No address, postcode, name or driver identity is included, and',
      'the round sequence was deliberately removed: ordered positions plus coordinates plus a',
      "date reconstruct a named person's movements for the day, which is a tracking record",
      'rather than a map of where the work is.',
      '',
      'Bounding boxes with seeded data: London is `-0.30,51.40,0.10,51.60` and the Karachi',
      'depot is `66.9,24.7,67.3,25.1`. The seed also places stops in Lahore and Islamabad, so',
      'a country-wide box with a low zoom is the clearest way to see clustering.',
      '',
      'A driver may only ever see today. Passing `date` with a driver token is refused, and',
      'only an office token may ask for another day.',
    ].join('\n'),
  })
  @ApiQuery({
    name: 'date',
    required: false,
    description:
      'Which day to draw, as an ISO date such as 2026-08-14. Office tokens only: a driver passing it gets 403, because an arbitrary date turns a live operational map into a movement archive. Left deliberately blank in this form so the request runs as-is on a driver token. Defaults to today, which is also the only day the demo data can draw: the seeded historical stops carry the legacy location string with no lat/lng and the map query skips anything without coordinates, so an earlier date returns an empty collection rather than an error.',
  })
  @ApiQuery({
    name: 'bbox',
    required: false,
    description:
      'Viewport filter as `minLng,minLat,maxLng,maxLat`. Rejected rather than ignored when malformed, since a silently dropped bbox would quietly answer with the whole depot. Use `66.9,24.7,67.3,25.1` for the Karachi round.',
    example: '-0.30,51.40,0.10,51.60',
  })
  @ApiQuery({
    name: 'zoom',
    required: false,
    description:
      'Map zoom, 0 to 24. Below 13 the response is aggregated grid cells; 13 or above is individual stops capped at 1500. Omit it to get every stop with no cap. Try 10 and then 14 on the same bbox to see both shapes.',
    example: '14',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      'Comma-separated stop statuses to keep: any of `pending`, `attempted`, `delivered`, `failed`. Omit for all four. An unknown value is not an error, it simply matches nothing.',
    example: 'pending,attempted',
  })
  @ApiResponse({
    status: 200,
    description:
      'A GeoJSON FeatureCollection. `mode` says which shape you got: `points` for individual stops, `clustered` for aggregated cells.',
    content: {
      'application/json': {
        examples: {
          points: {
            summary: 'zoom 13 or above, or zoom omitted',
            value: {
              type: 'FeatureCollection',
              mode: 'points',
              truncated: false,
              features: [
                {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [-0.0567, 51.5296] },
                  properties: {
                    id: '28e634ba-ef89-4fcd-b21a-e9881367f757',
                    s: 2,
                  },
                },
                {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [-0.0644, 51.4713] },
                  properties: {
                    id: '8b21f0ac-4e77-45d1-8c6e-6f0a1d3b5c92',
                    s: 0,
                  },
                },
              ],
            },
          },
          clustered: {
            summary: 'below zoom 13: grid cells with counts, no ids',
            value: {
              type: 'FeatureCollection',
              mode: 'clustered',
              features: [
                {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [-0.0439, 51.5294] },
                  properties: { point_count: 214 },
                },
                {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [67.0166, 24.8657] },
                  properties: { point_count: 96 },
                },
              ],
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      '`bbox` was not four finite numbers or had a min above its max, `zoom` was outside 0 to 24, or `date` was not parseable as a date.',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing, expired or wrong-surface bearer token.',
  })
  @ApiResponse({
    status: 403,
    description:
      'A driver token passed `date`. Drivers are pinned to the current day; sign in with the office account to load any other date.',
  })
  depotGeoJson(
    @CurrentUser() user: JwtPayload,
    @Query('date') date?: string,
    @Query('bbox') bbox?: string,
    @Query('zoom') zoom?: string,
    @Query('status') status?: string,
  ) {
    if (date !== undefined && user.role !== 'office') {
      throw new ForbiddenException('Drivers may only load the current depot map');
    }
    return this.stopsService.depotGeoJson({
      date,
      bbox: parseBbox(bbox),
      zoom: parseZoom(zoom),
      status: status ? status.split(',').filter(Boolean) : undefined,
    });
  }
}

/** `minLng,minLat,maxLng,maxLat`. Rejected rather than ignored when malformed:
 *  a silently dropped bbox would answer with the whole depot. */
function parseBbox(raw?: string): DepotBbox | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new BadRequestException('bbox must be minLng,minLat,maxLng,maxLat');
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (minLng > maxLng || minLat > maxLat) {
    throw new BadRequestException('bbox min must not exceed max');
  }
  return { minLng, minLat, maxLng, maxLat };
}

function parseZoom(raw?: string): number | undefined {
  if (!raw) return undefined;
  const zoom = Number(raw);
  if (!Number.isFinite(zoom) || zoom < 0 || zoom > 24) {
    throw new BadRequestException('zoom must be between 0 and 24');
  }
  return zoom;
}
