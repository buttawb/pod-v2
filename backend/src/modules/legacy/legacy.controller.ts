import { Body, Controller, Get, Param, ParseUUIDPipe, Post, VERSION_NEUTRAL } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { LegacyPodDto } from './dto/legacy-pod.dto';
import { LegacyService } from './legacy.service';

/**
 * FROZEN v1 surface - /api/stops and /api/stops/:id/pod, exactly as the
 * live v1.4.2 fleet calls them. Guarded by golden-file contract tests; any
 * change to a byte of these responses fails the test suite.
 */
@Roles('driver')
@Controller({ path: 'stops', version: VERSION_NEUTRAL })
export class LegacyController {
  constructor(private readonly legacyService: LegacyService) {}

  @Get()
  getStops(@CurrentUser() user: JwtPayload) {
    return this.legacyService.getStops(user);
  }

  @Post(':id/pod')
  submitPod(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) stopId: string,
    @Body() dto: LegacyPodDto,
  ) {
    return this.legacyService.submitPod(user, stopId, dto);
  }
}
