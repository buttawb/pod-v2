import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { uuidv5 } from '../../common/uuid5';
import { Outcome } from '../../domain/outcomes';
import { notifyAttemptEvent } from '../events/notify';
import { PodsProjectionService } from '../attempts/pods-projection.service';
import { Stop } from '../stops/entities/stop.entity';
import { Pod } from './entities/pod.entity';
import type { LegacyPodDto } from './dto/legacy-pod.dto';

/**
 * Namespace for deriving deterministic idempotency keys from legacy
 * requests. v1 clients have no idempotency key, so we mint one from
 * (stop_id, payload): a network retry of the identical request dedupes for
 * free; a different body for the same stop is a new attempt - which is
 * exactly right, it's a new event.
 */
const LEGACY_IDEMPOTENCY_NS = 'e8a9c7c1-4b1f-4b5e-9dd4-9f1a2b3c4d5e';

const LEGACY_APP_VERSION = '<=1.4.2';

@Injectable()
export class LegacyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Stop) private readonly stops: Repository<Stop>,
    @InjectRepository(Pod) private readonly pods: Repository<Pod>,
    private readonly podsProjection: PodsProjectionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The frozen v1 read: the driver's full stop history with its pod.
   * Unbounded by design - byte-compatibility with the live contract beats
   * fixing v1's flaws (that unboundedness is the documented 100x canary).
   */
  async getStops(user: JwtPayload): Promise<Record<string, unknown>[]> {
    const rows = (await this.dataSource.query(
      `SELECT s.id, s.driver_id, s.address, s.postcode, s.location, s.sequence, s.created_at,
              p.id AS pod_id, p.delivered, p.photo_url, p.signature_url,
              p.location AS pod_location, p.note, p.created_at AS pod_created_at
       FROM stops s
       LEFT JOIN pods p ON p.stop_id = s.id
       WHERE s.driver_id = $1
       ORDER BY s.created_at DESC, s.sequence ASC`,
      [user.sub],
    )) as Array<Record<string, unknown>>;

    // Field whitelist, never SELECT * -> JSON: new columns on stops must be
    // invisible to the frozen contract (enforced by the golden-file test).
    return rows.map((r) => ({
      id: r.id,
      driver_id: r.driver_id,
      address: r.address,
      postcode: r.postcode,
      location: r.location,
      sequence: r.sequence,
      created_at: r.created_at,
      pod:
        r.pod_id === null
          ? null
          : {
              id: r.pod_id,
              stop_id: r.id,
              delivered: r.delivered,
              photo_url: r.photo_url,
              signature_url: r.signature_url,
              location: r.pod_location,
              note: r.note,
              created_at: r.pod_created_at,
            },
    }));
  }

  /**
   * v1 write, adapted onto the v2 evidence table. The raw body is preserved
   * verbatim in raw_payload - a legal query can always distinguish "driver
   * asserted delivered_to_person on v2" from "legacy boolean mapped to it".
   */
  async submitPod(user: JwtPayload, stopId: string, body: LegacyPodDto) {
    const stop = await this.stops.findOne({ where: { id: stopId } });
    if (!stop) throw new NotFoundException('Unknown stop');
    if (stop.driverId !== user.sub) throw new ForbiddenException('Stop belongs to another driver');

    const outcome: Outcome = body.delivered ? Outcome.DeliveredToPerson : Outcome.NoAnswerCarded;
    const rawPayload = {
      delivered: body.delivered,
      photo_url: body.photo_url ?? null,
      signature_url: body.signature_url ?? null,
      location: body.location ?? null,
      note: body.note ?? null,
    };
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ stopId, ...rawPayload }))
      .digest('hex');
    // v1 carries no idempotency key, so one is derived. The time bucket is
    // what makes it safe: a network retry arrives within seconds and dedupes,
    // while a genuine second attempt at the same stop hours later (identical
    // note, identical outcome) is correctly recorded as a new event rather
    // than silently discarded.
    const bucket = Math.floor(Date.now() / (5 * 60_000));
    const clientAttemptId = uuidv5(`${stopId}:${payloadHash}:${bucket}`, LEGACY_IDEMPOTENCY_NS);

    const coords =
      this.parseLatLng(body.location) ?? this.parseLatLng(stop.location) ?? { lat: stop.lat, lng: stop.lng };
    if (coords.lat === null || coords.lng === null) {
      // v1 rows always carry a parseable stop location; this is unreachable
      // for real data but the evidence table requires coordinates.
      throw new NotFoundException('Stop has no usable coordinates');
    }

    await this.dataSource.transaction(async (em) => {
      const inserted = (await em.query(
        `INSERT INTO delivery_attempts (
           client_attempt_id, stop_id, driver_id, outcome, note, lat, lng,
           captured_at, app_version, source, raw_payload,
           declared_photo_count, evidence_status, payload_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,'v1_compat',$9,0,'complete',$10)
         ON CONFLICT (client_attempt_id) DO NOTHING
         RETURNING id`,
        [
          clientAttemptId,
          stopId,
          user.sub,
          outcome,
          body.note ?? null,
          coords.lat,
          coords.lng,
          LEGACY_APP_VERSION,
          JSON.stringify(rawPayload),
          payloadHash,
        ],
      )) as Array<{ id: string }>;

      if (inserted.length === 0) return; // identical retry - already recorded

      await this.podsProjection.projectStop(
        em,
        stopId,
        this.config.get<boolean>('DUAL_WRITE_PODS', true),
      );
      await notifyAttemptEvent(em, {
        attemptId: inserted[0].id,
        stopId,
        driverId: user.sub,
        outcome,
        evidenceStatus: 'complete',
        receivedAt: new Date().toISOString(),
      });
    });

    // v1 clients expect the pod row back (assumption documented in
    // DECISIONS.md). The response is never allowed to depend on the
    // dual-write flag: turning that off during the contract phase must not
    // start returning 500 to a fleet we promised not to break, so the v1
    // shape is synthesised from the attempt when no projection row exists.
    const pod = await this.pods.findOne({ where: { stopId } });
    if (pod) {
      return {
        id: pod.id,
        stop_id: pod.stopId,
        delivered: pod.delivered,
        photo_url: pod.photoUrl,
        signature_url: pod.signatureUrl,
        location: pod.location,
        note: pod.note,
        created_at: pod.createdAt,
      };
    }

    const [attempt] = (await this.dataSource.query(
      `SELECT id, received_at FROM delivery_attempts WHERE client_attempt_id = $1`,
      [clientAttemptId],
    )) as Array<{ id: string; received_at: Date }>;
    return {
      id: attempt?.id ?? stopId,
      stop_id: stopId,
      delivered: body.delivered,
      photo_url: body.photo_url ?? null,
      signature_url: body.signature_url ?? null,
      location: body.location ?? `${coords.lat},${coords.lng}`,
      note: body.note ?? null,
      created_at: attempt?.received_at ?? new Date(),
    };
  }

  private parseLatLng(value: string | null | undefined): { lat: number; lng: number } | null {
    if (!value) return null;
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
    if (!match) return null;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }
}
