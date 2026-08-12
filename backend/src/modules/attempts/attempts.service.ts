import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { validateEvidence } from '../../domain/outcomes';
import { notifyAttemptEvent } from '../events/notify';
import { S3Service } from '../media/s3.service';
import { Stop } from '../stops/entities/stop.entity';
import { CreateAttemptDto } from './dto/create-attempt.dto';
import { AttemptPhoto, PhotoStatus } from './entities/attempt-photo.entity';
import { DeliveryAttempt } from './entities/delivery-attempt.entity';
import { PodsProjectionService } from './pods-projection.service';

const CLOCK_SUSPECT_SKEW_MS = 5 * 60_000;
const MIN_OBJECT_BYTES = 1024; // an "uploaded photo" of a few bytes is a failed upload, not evidence

export interface UploadTarget {
  kind: 'photo' | 'signature';
  photoIndex?: number;
  s3Key: string;
  url: string;
  expiresInSec: number;
}

export interface CreateAttemptResult {
  attemptId: string;
  clientAttemptId: string;
  evidenceStatus: string;
  deduplicated: boolean;
  uploads: UploadTarget[];
  /** Present (true) when presigning failed; the attempt itself is safe and URLs can be re-requested. */
  uploadUrlsUnavailable?: boolean;
  /**
   * The stop moved to another driver between capture and sync. The evidence
   * is stored and the office has it in its conflicts queue; the handset shows
   * it so the driver is not left believing the stop is still theirs.
   */
  conflict?: boolean;
  conflictReason?: string;
}

export const ATTEMPT_CREATED_EVENT = 'attempt.created';

export interface AttemptCreatedEvent {
  attemptId: string;
  outcome: string;
  note: string | null;
}

@Injectable()
export class AttemptsService {
  private readonly logger = new Logger(AttemptsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Stop) private readonly stops: Repository<Stop>,
    @InjectRepository(DeliveryAttempt) private readonly attempts: Repository<DeliveryAttempt>,
    private readonly s3: S3Service,
    private readonly podsProjection: PodsProjectionService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The one write path for evidence. Idempotent by construction: the unique
   * index on client_attempt_id is the serialization point across load-balanced
   * instances - no app-level locks, Postgres is the arbiter. A replay with the
   * same payload is indistinguishable from success (200, deduplicated flag);
   * a replay with a DIFFERENT payload is a client bug surfaced as 422, never
   * silently resolved.
   */
  async create(user: JwtPayload, dto: CreateAttemptDto): Promise<CreateAttemptResult> {
    this.validateStructure(dto);

    const stop = await this.stops.findOne({ where: { id: dto.stopId } });
    if (!stop) throw new NotFoundException('Unknown stop');

    const payloadHash = this.canonicalHash(dto);
    const capturedAt = new Date(dto.capturedAt);
    const clockSuspect = capturedAt.getTime() > Date.now() + CLOCK_SUSPECT_SKEW_MS;

    /**
     * A stop that has moved to another driver.
     *
     * This used to be a flat 403, which is right for someone reaching for
     * work that was never theirs and wrong for the case that actually
     * happens: dispatch reassigns a stop while the driver holding it is
     * offline, and that driver has already delivered the parcel. Refusing
     * their sync deletes the only record of a real delivery.
     *
     * The two are told apart by when the capture happened. A capture that
     * predates the stop's last change is consistent with "this was mine when
     * I was standing at the door", so it is accepted and flagged for the
     * office. A capture made after the stop moved is someone recording work
     * against a stop that was already not theirs, and that is still refused.
     *
     * We cannot do better than this without an assignment history table: the
     * stop row remembers who owns it now, not who owned it at 09:14. That is
     * a deliberate limit, and the flag is what keeps it visible rather than
     * silently trusted.
     */
    let conflictReason: string | null = null;
    if (stop.driverId !== user.sub) {
      if (capturedAt.getTime() >= stop.updatedAt.getTime()) {
        throw new ForbiddenException('Stop belongs to another driver');
      }
      conflictReason = `Stop was reassigned after this attempt was captured (captured ${capturedAt.toISOString()}, stop last changed ${stop.updatedAt.toISOString()})`;
    }

    const { attempt, photos, deduplicated } = await this.dataSource.transaction(async (em) => {
      const inserted = (await em.query(
        `INSERT INTO delivery_attempts (
           client_attempt_id, stop_id, driver_id, device_id, parcel_barcode, barcode_source,
           outcome, signature_s3_key, signature_declared_size_bytes,
           neighbour_house_number, reason_code, note,
           lat, lng, gps_accuracy_m, captured_at, clock_suspect, app_version,
           source, declared_photo_count, evidence_status, payload_hash,
           conflict, conflict_reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'v2',$19,$20,$21,$22,$23)
         ON CONFLICT (client_attempt_id) DO NOTHING
         RETURNING id`,
        [
          dto.clientAttemptId,
          dto.stopId,
          user.sub,
          user.deviceId ?? null,
          dto.parcelBarcode ?? null,
          dto.parcelBarcode ? (dto.barcodeSource ?? 'manual') : null,
          dto.outcome,
          dto.signature ? this.signatureKey(dto.clientAttemptId) : null,
          dto.signature ? String(dto.signature.sizeBytes) : null,
          dto.neighbourHouseNumber ?? null,
          dto.reasonCode ?? null,
          dto.note ?? null,
          dto.lat,
          dto.lng,
          dto.gpsAccuracyM ?? null,
          capturedAt.toISOString(),
          clockSuspect,
          dto.appVersion,
          dto.photos?.length ?? 0,
          // No declared media at all -> the attempt JSON is the whole evidence.
          dto.photos?.length || dto.signature ? 'pending_media' : 'complete',
          payloadHash,
          conflictReason !== null,
          conflictReason,
        ],
      )) as Array<{ id: string }>;

      if (inserted.length === 0) {
        // Replay (retry, force-quit resend, or a race lost to the other LB
        // instance). The existing row decides everything.
        const existing = await em.getRepository(DeliveryAttempt).findOneOrFail({
          where: { clientAttemptId: dto.clientAttemptId },
        });
        if (existing.driverId !== user.sub) {
          // A globally-unique key must never become a cross-driver oracle.
          throw new ForbiddenException('Attempt belongs to another driver');
        }
        if (existing.payloadHash !== payloadHash) {
          throw new UnprocessableEntityException({
            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: 'client_attempt_id was reused with a different payload',
          });
        }
        const existingPhotos = await em.getRepository(AttemptPhoto).find({
          where: { attemptId: existing.id },
        });
        return { attempt: existing, photos: existingPhotos, deduplicated: true };
      }

      const attemptId = inserted[0].id;

      const manifest = (dto.photos ?? []).map((p) => ({
        attemptId,
        photoIndex: p.index,
        s3Key: this.photoKey(dto.clientAttemptId, p.index),
        contentType: 'image/jpeg',
        declaredSizeBytes: String(p.sizeBytes),
        status: PhotoStatus.AwaitingUpload,
      }));
      if (manifest.length > 0) {
        await em.getRepository(AttemptPhoto).insert(manifest);
      }

      await this.podsProjection.projectStop(em, stop.id, this.dualWritePods());

      const created = await em.getRepository(DeliveryAttempt).findOneOrFail({
        where: { id: attemptId },
      });
      await notifyAttemptEvent(em, {
        attemptId,
        stopId: stop.id,
        driverId: user.sub,
        outcome: created.outcome,
        evidenceStatus: created.evidenceStatus,
        receivedAt: created.receivedAt.toISOString(),
      });

      const createdPhotos = await em.getRepository(AttemptPhoto).find({ where: { attemptId } });
      return { attempt: created, photos: createdPhotos, deduplicated: false };
    });

    if (!deduplicated && attempt.note) {
      this.events.emit(ATTEMPT_CREATED_EVENT, {
        attemptId: attempt.id,
        outcome: attempt.outcome,
        note: attempt.note,
      } satisfies AttemptCreatedEvent);
    }

    // Presigning stays outside the transaction, and its failure must not
    // fail the submit: the attempt JSON (the legally critical half) is
    // already durable. The client re-requests URLs via upload-urls.
    let uploads: UploadTarget[] = [];
    let uploadUrlsUnavailable = false;
    try {
      uploads = await this.buildUploads(attempt, photos, dto);
    } catch (err) {
      uploadUrlsUnavailable = true;
      this.logger.error(`Presign failed for ${attempt.clientAttemptId}: ${(err as Error).message}`);
    }
    return {
      attemptId: attempt.id,
      clientAttemptId: attempt.clientAttemptId,
      evidenceStatus: attempt.evidenceStatus,
      deduplicated,
      uploads,
      ...(uploadUrlsUnavailable ? { uploadUrlsUnavailable } : {}),
      // Read from the stored row, not from the local variable: on a replay
      // the insert did not happen here, and the row is the authority on
      // whether this attempt was ever flagged.
      ...(attempt.conflict
        ? { conflict: true, conflictReason: attempt.conflictReason ?? undefined }
        : {}),
    };
  }

  /**
   * Verifies every declared object against S3 (HeadObject - never the
   * client's word) and flips evidence_status when the manifest is satisfied.
   * Idempotent: re-finalizing a complete attempt is a no-op returning state.
   */
  async finalize(user: JwtPayload, clientAttemptId: string) {
    const attempt = await this.getOwnedAttempt(user, clientAttemptId);

    const photos = await this.dataSource.getRepository(AttemptPhoto).find({
      where: { attemptId: attempt.id },
      order: { photoIndex: 'ASC' },
    });

    for (const photo of photos) {
      // Every declared object is checked against S3 on every call, whatever
      // the row currently says. Skipping rows that were not `awaiting_upload`
      // meant the database's opinion decided whether we bothered to look, and
      // the database is exactly what is wrong when an attempt is stuck.
      // HeadObject is cheap; a stranded evidence file is not.
      if (photo.status === PhotoStatus.Verified) continue;
      const head = await this.s3.headObject(photo.s3Key);
      if (!head) continue; // not uploaded yet - stays awaiting
      if (this.objectAcceptable(head.sizeBytes, photo.declaredSizeBytes, head.contentType)) {
        await this.dataSource.getRepository(AttemptPhoto).update(
          { id: photo.id },
          {
            status: PhotoStatus.Verified,
            sizeBytes: String(head.sizeBytes),
            etag: head.etag,
            verifiedAt: new Date(),
          },
        );
      }
    }

    if (attempt.signatureS3Key && !attempt.signatureVerifiedAt) {
      const head = await this.s3.headObject(attempt.signatureS3Key);
      if (head && head.sizeBytes >= MIN_OBJECT_BYTES) {
        await this.dataSource.query(
          `UPDATE delivery_attempts
           SET signature_verified_at = now(), signature_size_bytes = $2
           WHERE id = $1 AND signature_verified_at IS NULL`,
          [attempt.id, head.sizeBytes],
        );
      }
    }

    // Completeness decided under a row lock so two concurrent finalizes
    // can't double-fire the completion event or disagree on state.
    const result = await this.dataSource.transaction(async (em) => {
      const [row] = (await em.query(
        `SELECT evidence_status, signature_s3_key, signature_verified_at
         FROM delivery_attempts WHERE id = $1 FOR UPDATE`,
        [attempt.id],
      )) as Array<{
        evidence_status: string;
        signature_s3_key: string | null;
        signature_verified_at: Date | null;
      }>;

      const [pending] = (await em.query(
        `SELECT count(*)::int AS n FROM attempt_photos
         WHERE attempt_id = $1 AND status = 'awaiting_upload'`,
        [attempt.id],
      )) as Array<{ n: number }>;

      const signatureSatisfied = !row.signature_s3_key || row.signature_verified_at !== null;
      const complete = pending.n === 0 && signatureSatisfied;

      if (complete && row.evidence_status === 'pending_media') {
        await em.query(
          `UPDATE delivery_attempts SET evidence_status = 'complete', updated_at = now()
           WHERE id = $1`,
          [attempt.id],
        );
        await notifyAttemptEvent(em, {
          attemptId: attempt.id,
          stopId: attempt.stopId,
          driverId: attempt.driverId,
          outcome: attempt.outcome,
          evidenceStatus: 'complete',
          receivedAt: attempt.receivedAt.toISOString(),
        });
      }
      return { complete: complete || row.evidence_status === 'complete', pendingPhotos: pending.n, signatureSatisfied };
    });

    const refreshed = await this.dataSource.getRepository(AttemptPhoto).find({
      where: { attemptId: attempt.id },
      order: { photoIndex: 'ASC' },
    });

    return {
      attemptId: attempt.id,
      clientAttemptId,
      evidenceStatus: result.complete ? 'complete' : 'pending_media',
      attemptComplete: result.complete,
      photos: refreshed.map((p) => ({ index: p.photoIndex, status: p.status })),
      signatureSatisfied: result.signatureSatisfied,
    };
  }

  /** Re-issues presigned PUTs for whatever is still unverified (URLs expire; state does not). */
  async uploadUrls(user: JwtPayload, clientAttemptId: string): Promise<UploadTarget[]> {
    const attempt = await this.getOwnedAttempt(user, clientAttemptId);
    const photos = await this.dataSource.getRepository(AttemptPhoto).find({
      where: { attemptId: attempt.id },
      order: { photoIndex: 'ASC' },
    });
    return this.buildUploads(attempt, photos, null);
  }

  private async getOwnedAttempt(user: JwtPayload, clientAttemptId: string): Promise<DeliveryAttempt> {
    const attempt = await this.attempts.findOne({ where: { clientAttemptId } });
    if (!attempt) throw new NotFoundException('Unknown attempt');
    if (attempt.driverId !== user.sub) throw new ForbiddenException('Attempt belongs to another driver');
    return attempt;
  }

  private async buildUploads(
    attempt: DeliveryAttempt,
    photos: AttemptPhoto[],
    dto: CreateAttemptDto | null,
  ): Promise<UploadTarget[]> {
    const putTtl = this.config.get<number>('PRESIGN_PUT_TTL_SEC', 900);
    const uploads: UploadTarget[] = [];

    for (const photo of photos) {
      if (photo.status !== PhotoStatus.AwaitingUpload) continue;
      const size = Number(photo.declaredSizeBytes ?? 0);
      uploads.push({
        kind: 'photo',
        photoIndex: photo.photoIndex,
        s3Key: photo.s3Key,
        url: await this.s3.presignPut(photo.s3Key, photo.contentType, size),
        expiresInSec: putTtl,
      });
    }

    if (attempt.signatureS3Key && !attempt.signatureVerifiedAt) {
      // The size the client declared, never a guess: Content-Length is part
      // of the signature, so a wrong value means S3 rejects every upload.
      const declaredSize =
        dto?.signature?.sizeBytes ??
        (attempt.signatureDeclaredSizeBytes ? Number(attempt.signatureDeclaredSizeBytes) : null);
      if (declaredSize === null) {
        this.logger.error(
          `No declared signature size for ${attempt.clientAttemptId}; cannot presign`,
        );
      } else {
        uploads.push({
          kind: 'signature',
          s3Key: attempt.signatureS3Key,
          url: await this.s3.presignPut(attempt.signatureS3Key, 'image/png', declaredSize),
          expiresInSec: putTtl,
        });
      }
    }

    return uploads;
  }

  private validateStructure(dto: CreateAttemptDto): void {
    const indexes = (dto.photos ?? []).map((p) => p.index);
    if (new Set(indexes).size !== indexes.length) {
      throw new UnprocessableEntityException({ code: 'DUPLICATE_PHOTO_INDEX' });
    }
    const violations = validateEvidence(dto.outcome, {
      hasSignature: dto.signature !== undefined,
      photoCount: indexes.length,
      reasonCode: dto.reasonCode ?? null,
      neighbourHouseNumber: dto.neighbourHouseNumber ?? null,
    });
    if (violations.length > 0) {
      throw new UnprocessableEntityException({ code: 'EVIDENCE_RULES_VIOLATED', violations });
    }
  }

  private objectAcceptable(
    sizeBytes: number,
    declaredSizeBytes: string | null,
    contentType: string | undefined,
  ): boolean {
    if (sizeBytes < MIN_OBJECT_BYTES) return false;
    if (declaredSizeBytes !== null && Number(declaredSizeBytes) !== sizeBytes) return false;

    // An absent or empty content type is not a reason to reject evidence.
    //
    // This test used to be `contentType !== undefined && !startsWith('image/')`,
    // and S3 reports an empty string, not undefined, when the stored object
    // carries no content type. React Native's fetch derives the request's
    // Content-Type from the blob it is given rather than the header we set,
    // and a blob read from a file URI has no type, so every photo this app
    // uploaded landed in S3 with ContentType "". The empty string is not
    // undefined and does not start with "image/", so the server rejected
    // byte-perfect evidence it had itself presigned, forever, on a metadata
    // field it never guaranteed would survive the round trip.
    //
    // The signature escaped this because its check is size-only, which is why
    // a signature verified in the same call where the photo did not.
    //
    // The bytes are the evidence. A declared size that matches to the byte is
    // a far stronger statement than a header, and it is already checked above.
    if (contentType && !contentType.startsWith('image/')) return false;
    return true;
  }

  /** Deterministic, server-dictated keys: re-uploads overwrite identical bytes, never duplicate. */
  private photoKey(clientAttemptId: string, index: number): string {
    return `attempts/${clientAttemptId}/${index}.jpg`;
  }

  private signatureKey(clientAttemptId: string): string {
    return `attempts/${clientAttemptId}/signature.png`;
  }

  private dualWritePods(): boolean {
    return this.config.get<boolean>('DUAL_WRITE_PODS', true);
  }

  /** Stable-ordered hash of the evidence-bearing fields - the key-reuse tripwire. */
  private canonicalHash(dto: CreateAttemptDto): string {
    const canonical = JSON.stringify({
      clientAttemptId: dto.clientAttemptId,
      stopId: dto.stopId,
      outcome: dto.outcome,
      parcelBarcode: dto.parcelBarcode ?? null,
      barcodeSource: dto.barcodeSource ?? null,
      neighbourHouseNumber: dto.neighbourHouseNumber ?? null,
      reasonCode: dto.reasonCode ?? null,
      note: dto.note ?? null,
      lat: dto.lat,
      lng: dto.lng,
      gpsAccuracyM: dto.gpsAccuracyM ?? null,
      capturedAt: dto.capturedAt,
      photos: (dto.photos ?? [])
        .map((p) => ({ index: p.index, sizeBytes: p.sizeBytes }))
        .sort((a, b) => a.index - b.index),
      signature: dto.signature ? { sizeBytes: dto.signature.sizeBytes } : null,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }
}
