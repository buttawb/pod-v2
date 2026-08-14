import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/jwt-auth.guard';
import { decodeCursor } from '../../common/pagination/cursor';
import { OfficeService } from './office.service';

/**
 * The conflicts queue at its own top-level path.
 *
 * Same handler, same provider instance, same office role: the path segment is
 * baked into the class-level @Controller decorator on OfficeController, so a
 * second short-lived controller is the way to answer at /api/v2/conflicts
 * without duplicating the query. Registered in the same module so Nest
 * injects the identical OfficeService.
 *
 * Read-only by construction: there is no write route here and nothing that
 * resolves a conflict. A conflict is settled by acting on the stop, never by
 * editing the evidence that reported it.
 */
@Roles('office')
@ApiTags('office')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'conflicts', version: '2' })
export class ConflictsController {
  constructor(private readonly officeService: OfficeService) {}

  @Get()
  @ApiOperation({
    summary: 'Deliveries filed against a stop the driver no longer owns',
    description: [
      'Completed deliveries with a paperwork problem, not failures: the driver was at the door',
      'before dispatch reassigned the stop. The evidence is kept and shown here so the office',
      'finds out from us rather than from the customer.',
      '',
      '**This is the same endpoint as GET /api/v2/office/conflicts.** One handler, one service',
      'call, one office role, listed at two paths because the queue reads naturally both as a',
      'top-level resource and as part of the office view. They cannot return different things,',
      'so pick whichever path you prefer.',
      '',
      'Requires an OFFICE token. Sign in at POST /api/v2/auth/office/login with',
      'office@demo.pod / OfficeDemo#2026, copy `accessToken`, then press Authorize at the top of',
      'this page and paste it. A driver token is refused. Those sign-in details are printed here',
      'knowingly: they belong to a demo account seeded for this evaluation on a demo database,',
      'so the page can be run as it stands.',
      '',
      'Read-only. There is no route here that resolves a conflict, because a conflict is settled',
      'by acting on the stop, never by editing the evidence that reported it.',
      '',
      'Send it with no parameters for the first page, then feed `nextCursor` back in as `cursor`',
      'while `hasMore` is true.',
    ].join('\n'),
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Opaque keyset cursor. Leave empty for the first page, then pass the `nextCursor` from ' +
      'the previous response. Keyset rather than offset, so nothing is skipped or repeated ' +
      'while new attempts are arriving.',
    example:
      'eyJ0cyI6IjIwMjYtMDgtMTQgMDk6NDE6MTIuNDgzMjE3KzAwIiwiaWQiOiI4ZjE0ZTQ1Zi1jZWVhLTQ2N2EtOWMyYi0yZjJkMGMxZjdhMTAifQ',
  })
  @ApiResponse({
    status: 200,
    description:
      'Up to 50 conflicts, newest first. `driver_name` is who filed the evidence, ' +
      '`current_driver_name` is who owns the stop now, and null there means nobody does.',
    schema: {
      example: {
        conflicts: [
          {
            id: '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10',
            stop_id: '3d1c9a76-6b0e-4f2e-9d51-9a0f5a1c77b2',
            outcome: 'delivered_to_person',
            evidence_status: 'complete',
            captured_at: '2026-08-14T09:40:58.000Z',
            received_at: '2026-08-14T09:41:12.483Z',
            conflict_reason: 'stop_reassigned',
            address: '14 Ravenscourt Road',
            postcode: 'W6 0UH',
            driver_name: 'Test Driver',
            current_driver_name: 'Karachi Driver',
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'The `cursor` was not one this API issued. Copy `nextCursor` verbatim instead of building ' +
      'a cursor by hand.',
    schema: {
      example: { message: 'Malformed cursor', error: 'Bad Request', statusCode: 400 },
    },
  })
  @ApiResponse({
    status: 401,
    description:
      'No token, an expired token, or a driver token. The guard answers 401 for the wrong role ' +
      'as well as for no role, so "Insufficient role" here means you used the driver login.',
    schema: {
      example: { message: 'Insufficient role', error: 'Unauthorized', statusCode: 401 },
    },
  })
  list(@Query('cursor') cursor?: string) {
    const keyset = cursor ? decodeCursor(cursor) : null;
    if (cursor && !keyset) throw new BadRequestException('Malformed cursor');
    return this.officeService.listConflicts(keyset);
  }
}
