import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
@ApiTags('stops')
@ApiBearerAuth('driver-or-office')
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
