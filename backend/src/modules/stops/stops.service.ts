import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { StopStatus } from '../../domain/outcomes';
import { AttemptPhoto } from '../attempts/entities/attempt-photo.entity';
import { DeliveryAttempt } from '../attempts/entities/delivery-attempt.entity';
import { Stop } from './entities/stop.entity';

export interface DepotBbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface DepotViewport {
  date?: string;
  bbox?: DepotBbox;
  zoom?: number;
  status?: string[];
}

/** Integer status codes keep the map payload small and `match` expressions cheap. */
const STATUS_CODE: Record<StopStatus, number> = {
  [StopStatus.Pending]: 0,
  [StopStatus.Attempted]: 1,
  [StopStatus.Delivered]: 2,
  [StopStatus.Failed]: 3,
};

@Injectable()
export class StopsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Stop) private readonly stops: Repository<Stop>,
  ) {}

  async todayForDriver(driverId: string) {
    const rows = (await this.dataSource.query(
      `SELECT id, address, postcode, location, sequence, status, lat, lng, updated_at
       FROM stops
       WHERE driver_id = $1 AND created_at >= date_trunc('day', now())
       ORDER BY sequence ASC`,
      [driverId],
    )) as Array<Record<string, unknown>>;
    return { stops: rows, serverTime: new Date().toISOString() };
  }

  async detailForDriver(driverId: string, stopId: string) {
    const stop = await this.stops.findOne({ where: { id: stopId } });
    if (!stop) throw new NotFoundException('Unknown stop');
    if (stop.driverId !== driverId) throw new ForbiddenException('Stop belongs to another driver');

    const attempts = await this.dataSource.getRepository(DeliveryAttempt).find({
      where: { stopId },
      order: { capturedAt: 'DESC' },
    });
    const photos = attempts.length
      ? await this.dataSource
          .getRepository(AttemptPhoto)
          .createQueryBuilder('p')
          .where('p.attempt_id IN (:...ids)', { ids: attempts.map((a) => a.id) })
          .orderBy('p.photo_index', 'ASC')
          .getMany()
      : [];

    return {
      stop: {
        id: stop.id,
        address: stop.address,
        postcode: stop.postcode,
        sequence: stop.sequence,
        status: stop.status,
        lat: stop.lat,
        lng: stop.lng,
      },
      attempts: attempts.map((a) => ({
        id: a.id,
        clientAttemptId: a.clientAttemptId,
        outcome: a.outcome,
        reasonCode: a.reasonCode,
        note: a.note,
        capturedAt: a.capturedAt,
        receivedAt: a.receivedAt,
        evidenceStatus: a.evidenceStatus,
        source: a.source,
        photos: photos
          .filter((p) => p.attemptId === a.id)
          .map((p) => ({ index: p.photoIndex, status: p.status })),
        hasSignature: a.signatureS3Key !== null,
      })),
    };
  }

  /**
   * Zoom at which the payload switches from aggregated cells to real stops.
   * Below this a viewport covers a city or a country, where individual pins
   * are unreadable anyway and only the shape of the work matters.
   */
  private static readonly POINT_ZOOM = 13;

  /** Hard ceiling on rows returned to a handset in point mode. */
  private static readonly MAX_POINTS = 1500;

  async depotGeoJson(options: DepotViewport = {}) {
    const { date, bbox, zoom, status } = options;

    // An unparseable date would otherwise surface as a Postgres cast error
    // (500); reject it at the boundary instead.
    if (date !== undefined && Number.isNaN(Date.parse(date))) {
      throw new BadRequestException('date must be an ISO date');
    }

    // Bounded to one day's stops: the depot's live working set.
    const day = `created_at >= date_trunc('day', COALESCE($1::timestamptz, now()))
                 AND created_at < date_trunc('day', COALESCE($1::timestamptz, now())) + interval '1 day'
                 AND lat IS NOT NULL`;

    const params: unknown[] = [date ?? null];
    let where = day;

    if (bbox) {
      // Served by the GiST index on point(lng, lat).
      params.push(bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat);
      where += ` AND lng BETWEEN $${params.length - 3} AND $${params.length - 1}
                 AND lat BETWEEN $${params.length - 2} AND $${params.length}`;
    }

    if (status?.length) {
      params.push(status);
      where += ` AND status = ANY($${params.length}::text[])`;
    }

    // No zoom means "give me the working set", which is the original contract
    // and what the office dashboard still asks for: a desktop renders all
    // ~5,000 happily and clusters them itself. Aggregation is opt-in, driven by
    // a client that has told us how far out it is looking.
    const wantsEverything = zoom === undefined;
    const detailed = wantsEverything || zoom >= StopsService.POINT_ZOOM;

    if (!detailed) {
      // Aggregate in the database so a country-wide view costs one small
      // response instead of every stop the depot owns. The cell shrinks as the
      // map zooms, which is what keeps the counts meaningful rather than one
      // blob over the city.
      const cell = StopsService.cellSizeDegrees(zoom);
      params.push(cell);
      const cellParam = `$${params.length}`;

      const cells = (await this.dataSource.query(
        `SELECT floor(lng / ${cellParam}) * ${cellParam} + ${cellParam} / 2 AS lng,
                floor(lat / ${cellParam}) * ${cellParam} + ${cellParam} / 2 AS lat,
                count(*)::int AS point_count
           FROM stops
          WHERE ${where}
          GROUP BY 1, 2
          ORDER BY point_count DESC
          LIMIT 400`,
        params,
      )) as Array<{ lng: number; lat: number; point_count: number }>;

      return {
        type: 'FeatureCollection',
        mode: 'clustered',
        features: cells.map((c) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
          properties: { point_count: c.point_count },
        })),
      };
    }

    let limitClause = '';
    if (!wantsEverything) {
      params.push(StopsService.MAX_POINTS + 1);
      limitClause = ` LIMIT $${params.length}`;
    }

    const rows = (await this.dataSource.query(
      `SELECT id, status, lat, lng
         FROM stops
        WHERE ${where}${limitClause}`,
      params,
    )) as Array<{ id: string; status: StopStatus; lat: number; lng: number }>;

    // A silently truncated map is a lie about coverage, so say so and let the
    // client tell the operator to zoom in rather than trust what it sees.
    const truncated = !wantsEverything && rows.length > StopsService.MAX_POINTS;

    return {
      type: 'FeatureCollection',
      mode: 'points',
      truncated,
      features: (wantsEverything ? rows : rows.slice(0, StopsService.MAX_POINTS)).map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
        // Id, status and coordinates only. The round sequence used to ride
        // along as `q`, and nothing rendered it: ordered positions plus
        // coordinates plus a day is a reconstruction of the driver's route,
        // which is a movement record about a person rather than a map of
        // where the work is. Data minimisation is about what is sent, not
        // about what the client chooses to draw.
        properties: { id: r.id, s: STATUS_CODE[r.status] ?? 0 },
      })),
    };
  }

  /**
   * Grid cell width in degrees for a zoom level, roughly a fixed number of
   * screen pixels: each zoom step halves the ground covered by a tile.
   */
  private static cellSizeDegrees(zoom?: number): number {
    const z = Math.min(Math.max(zoom ?? 9, 0), StopsService.POINT_ZOOM);
    return 360 / 2 ** (z + 2);
  }
}
