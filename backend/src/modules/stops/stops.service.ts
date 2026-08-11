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

  async depotGeoJson(date?: string) {
    // An unparseable date would otherwise surface as a Postgres cast error
    // (500); reject it at the boundary instead.
    if (date !== undefined && Number.isNaN(Date.parse(date))) {
      throw new BadRequestException('date must be an ISO date');
    }

    // Bounded to one day's stops - the depot's live working set. The GiST
    // geo index serves bbox queries if this ever needs viewport filtering.
    const rows = (await this.dataSource.query(
      `SELECT id, status, sequence, lat, lng
       FROM stops
       WHERE created_at >= date_trunc('day', COALESCE($1::timestamptz, now()))
         AND created_at < date_trunc('day', COALESCE($1::timestamptz, now())) + interval '1 day'
         AND lat IS NOT NULL`,
      [date ?? null],
    )) as Array<{ id: string; status: StopStatus; sequence: number; lat: number; lng: number }>;

    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
        properties: { id: r.id, s: STATUS_CODE[r.status] ?? 0, q: r.sequence },
      })),
    };
  }
}
