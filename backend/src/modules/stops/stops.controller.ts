import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
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
   * ({id, s: status code, q: sequence} - no addresses or names; the map does
   * not need personal data). ~5,000 features ≈ 500KB, fetched once per
   * screen mount and rendered as a single GPU source.
   */
  @Get('stops.geojson')
  depotGeoJson(@Query('date') date?: string) {
    return this.stopsService.depotGeoJson(date);
  }
}
