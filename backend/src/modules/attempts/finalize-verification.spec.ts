import type { DataSource, Repository } from 'typeorm';
import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Audience } from '../../common/auth/jwt-payload';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import type { S3Service } from '../media/s3.service';
import { AttemptsService } from './attempts.service';
import { AttemptPhoto, PhotoStatus } from './entities/attempt-photo.entity';
import type { DeliveryAttempt } from './entities/delivery-attempt.entity';
import type { PodsProjectionService } from './pods-projection.service';

/**
 * Whether evidence counts as delivered is decided here and nowhere else.
 *
 * finalize is the only code path that ever looks in the bucket, so if it
 * refuses an object the object is stranded: the row stays awaiting_upload,
 * the attempt stays pending_media, and the driver's handset shows "finishing
 * evidence upload" until someone reads the database by hand. That happened.
 * A photo sat in S3, byte-for-byte the size the client declared, and was
 * refused on every call because S3 reported its content type as an empty
 * string rather than the "image/jpeg" the client set. React Native derives a
 * request's Content-Type from the blob it is given, not from the header, and
 * a blob read from a file URI has no type, so this was every photo the app
 * had ever uploaded rather than one bad file.
 *
 * These tests pin the rule that came out of it: the bytes are the evidence,
 * and metadata we never guaranteed would survive the round trip cannot veto
 * them.
 */
describe('finalize (S3 is the authority, not the row and not the headers)', () => {
  const DRIVER = 'a1c1d6f2-0d51-4f39-9a3a-4b7f0a2b1c01';
  const ATTEMPT_ID = 'd4f4a9c5-3a84-4c6c-8d6d-7eab3d5e4f04';
  const CLIENT_ID = 'f8ccc48a-2e34-455e-bcf1-cd91f3b9f77f';
  const PHOTO_KEY = `attempts/${CLIENT_ID}/0.jpg`;
  const DECLARED = 908_152;

  const user: JwtPayload = { sub: DRIVER, role: 'driver', aud: Audience.V2 };

  function build(opts: {
    head: { sizeBytes: number; contentType?: string; etag?: string } | null;
    photoStatus?: PhotoStatus;
  }) {
    const photo: Partial<AttemptPhoto> = {
      id: 'photo-row-1',
      attemptId: ATTEMPT_ID,
      photoIndex: 0,
      s3Key: PHOTO_KEY,
      declaredSizeBytes: String(DECLARED),
      status: opts.photoStatus ?? PhotoStatus.AwaitingUpload,
    };

    const attempt = {
      id: ATTEMPT_ID,
      clientAttemptId: CLIENT_ID,
      driverId: DRIVER,
      stopId: 'e5a5b0d6-4b95-4d7d-9e7e-8fbc4e6f5a05',
      outcome: 'delivered_to_person',
      // Completion notifies the office feed, which reads these.
      receivedAt: new Date('2026-08-12T10:25:06.540Z'),
      signatureS3Key: null,
      signatureVerifiedAt: null,
      evidenceStatus: 'pending_media',
    } as unknown as DeliveryAttempt;

    const photoUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    const getRepository = jest.fn((entity: unknown) => {
      if (entity === AttemptPhoto) {
        return {
          find: jest.fn().mockResolvedValue([photo as AttemptPhoto]),
          update: photoUpdate,
        };
      }
      return { find: jest.fn().mockResolvedValue([]), update: jest.fn() };
    });

    // The completeness decision runs in a transaction against raw SQL. The
    // count of still-pending rows is derived from what the loop above wrote,
    // so the fake reflects the update rather than answering from a script.
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return [
          {
            evidence_status: 'pending_media',
            signature_s3_key: null,
            signature_verified_at: null,
          },
        ];
      }
      if (sql.includes("status = 'awaiting_upload'")) {
        return [{ n: photoUpdate.mock.calls.length > 0 ? 0 : 1 }];
      }
      return [];
    });

    const dataSource = {
      getRepository,
      query,
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) =>
        fn({ query, getRepository }),
      ),
    } as unknown as DataSource;

    const attempts = {
      findOne: jest.fn().mockResolvedValue(attempt),
    } as unknown as Repository<DeliveryAttempt>;

    const s3 = { headObject: jest.fn().mockResolvedValue(opts.head) } as unknown as S3Service;

    const service = new AttemptsService(
      dataSource,
      { findOne: jest.fn() } as unknown as Repository<never>,
      attempts,
      s3,
      { projectStop: jest.fn() } as unknown as PodsProjectionService,
      { get: (_k: string, d: unknown) => d } as unknown as ConfigService,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );

    return { service, photoUpdate, s3 };
  }

  it('verifies a byte-perfect object whose stored content type is empty', async () => {
    // The exact shape S3 returned for the stuck attempt.
    const { service, photoUpdate } = build({
      head: { sizeBytes: DECLARED, contentType: '', etag: 'c6dde7a1' },
    });

    const result = await service.finalize(user, CLIENT_ID);

    expect(photoUpdate).toHaveBeenCalledWith(
      { id: 'photo-row-1' },
      expect.objectContaining({ status: PhotoStatus.Verified, sizeBytes: String(DECLARED) }),
    );
    expect(result.attemptComplete).toBe(true);
    expect(result.evidenceStatus).toBe('complete');
  });

  it('verifies an object the row still calls awaiting_upload', async () => {
    // The row is stale by definition in this scenario: it is what finalize is
    // being called to correct. Reading it to decide whether to look in the
    // bucket is what let a stuck attempt stay stuck.
    const { service, photoUpdate } = build({
      head: { sizeBytes: DECLARED, contentType: undefined },
      photoStatus: PhotoStatus.AwaitingUpload,
    });

    await service.finalize(user, CLIENT_ID);

    expect(photoUpdate).toHaveBeenCalled();
  });

  it('does not re-verify an object already marked verified', async () => {
    const { service, photoUpdate, s3 } = build({
      head: { sizeBytes: DECLARED },
      photoStatus: PhotoStatus.Verified,
    });

    await service.finalize(user, CLIENT_ID);

    expect(s3.headObject).not.toHaveBeenCalled();
    expect(photoUpdate).not.toHaveBeenCalled();
  });

  it('still refuses an object whose size contradicts what the client declared', async () => {
    // The size check is the one that carries the weight now, so it has to be
    // strict: a truncated upload is not evidence of anything.
    const { service, photoUpdate } = build({
      head: { sizeBytes: DECLARED - 1, contentType: 'image/jpeg' },
    });

    const result = await service.finalize(user, CLIENT_ID);

    expect(photoUpdate).not.toHaveBeenCalled();
    expect(result.attemptComplete).toBe(false);
  });

  it('still refuses an object that is plainly not an image', async () => {
    const { service, photoUpdate } = build({
      head: { sizeBytes: DECLARED, contentType: 'application/zip' },
    });

    await service.finalize(user, CLIENT_ID);

    expect(photoUpdate).not.toHaveBeenCalled();
  });

  it('leaves an object that has not arrived alone', async () => {
    const { service, photoUpdate } = build({ head: null });

    const result = await service.finalize(user, CLIENT_ID);

    expect(photoUpdate).not.toHaveBeenCalled();
    expect(result.attemptComplete).toBe(false);
  });
});
