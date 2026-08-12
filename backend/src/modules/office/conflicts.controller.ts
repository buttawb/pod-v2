import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
@Controller({ path: 'conflicts', version: '2' })
export class ConflictsController {
  constructor(private readonly officeService: OfficeService) {}

  @Get()
  list(@Query('cursor') cursor?: string) {
    const keyset = cursor ? decodeCursor(cursor) : null;
    if (cursor && !keyset) throw new BadRequestException('Malformed cursor');
    return this.officeService.listConflicts(keyset);
  }
}
