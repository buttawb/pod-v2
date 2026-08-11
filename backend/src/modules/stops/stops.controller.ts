import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { StopsService } from './stops.service';

@Roles('driver')
@Controller({ path: 'stops', version: '2' })
export class StopsController {
  constructor(private readonly stopsService: StopsService) {}

  /** Today's route, in planned sequence - the app's offline cache source. */
  @Get()
  today(@CurrentUser() user: JwtPayload) {
    return this.stopsService.todayForDriver(user.sub);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) stopId: string,
  ) {
    return this.stopsService.detailForDriver(user.sub, stopId);
  }
}

@Roles('driver', 'office')
@Controller({ path: 'depot', version: '2' })
export class DepotController {
  constructor(private readonly stopsService: StopsService) {}

  /**
   * The depot-overview map payload: every stop as a minimal GeoJSON feature
   * ({id, s: status code, q: sequence} - no addresses, names, or driver
   * identity; the map does not need personal data). ~5,000 features fetched
   * once per screen mount and rendered as a single GPU source.
   *
   * Fleet-wide visibility is the brief's requirement ("all ~5,000 stops for
   * the depot's coverage area on one map"), so a driver legitimately sees
   * other drivers' stops here. Drivers are pinned to TODAY's working set:
   * arbitrary dates would turn a live operational map into a historical
   * movement archive, which the product never asks for. Office users, who
   * already have per-attempt access, may request any date.
   */
  @Get('stops.geojson')
  depotGeoJson(@CurrentUser() user: JwtPayload, @Query('date') date?: string) {
    if (date !== undefined && user.role !== 'office') {
      throw new ForbiddenException('Drivers may only load the current depot map');
    }
    return this.stopsService.depotGeoJson(date);
  }
}
