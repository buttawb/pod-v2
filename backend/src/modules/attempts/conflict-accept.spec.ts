import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource, Repository } from 'typeorm';
import { Audience } from '../../common/auth/jwt-payload';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import type { S3Service } from '../media/s3.service';
import { AttemptsService } from './attempts.service';
import type { CreateAttemptDto } from './dto/create-attempt.dto';
import type { DeliveryAttempt } from './entities/delivery-attempt.entity';
import type { PodsProjectionService } from './pods-projection.service';
import { Stop } from '../stops/entities/stop.entity';

/**
 * A stop reassigned while its driver was offline.
 *
 * The driver has already been to the door, taken the photo and driven on. When
 * the handset finds signal, refusing that write deletes the only record of a
 * delivery that happened. The attempt is accepted, attributed to the driver who
 * actually made it, and flagged so the office finds out from us rather than
 * from the customer.
 *
 * The refusal half matters just as much: someone recording work against a stop
 * that was already not theirs is still refused, and these tests pin both so a
 * change cannot quietly turn the write path into an open door.
 */
describe('a reassigned stop is accepted and flagged, not refused', () => {
  const DRIVER = 'a1c1d6f2-0d51-4f39-9a3a-4b7f0a2b1c01';
  const OTHER_DRIVER = 'b2d2e7a3-1e62-4a4a-8b4b-5c8f1b3c2d02';
  const STOP = 'e5a5b0d6-4b95-4d7d-9e7e-8fbc4e6f5a05';
  const CLIENT_ID = 'f8ccc48a-2e34-455e-bcf1-cd91f3b9f77f';

  const user: JwtPayload = { sub: DRIVER, role: 'driver', aud: Audience.V2 };

  const REASSIGNED_AT = new Date('2026-08-12T10:00:00.000Z');

  function build(capturedAt: string) {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];

    const em = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        inserts.push({ sql, params });
        if (sql.includes('INSERT INTO delivery_attempts')) return [{ id: 'attempt-1' }];
        return [];
      }),
      getRepository: jest.fn(() => ({
        find: jest.fn().mockResolvedValue([]),
        insert: jest.fn(),
        findOneOrFail: jest.fn().mockResolvedValue({
          id: 'attempt-1',
          clientAttemptId: CLIENT_ID,
          stopId: STOP,
          driverId: DRIVER,
          outcome: 'delivered_to_person',
          evidenceStatus: 'complete',
          receivedAt: new Date('2026-08-12T11:00:00.000Z'),
          conflict: true,
          conflictReason: 'Stop was reassigned after this attempt was captured',
          note: null,
        }),
      })),
    };

    const dataSource = {
      transaction: jest.fn(async (fn: (m: unknown) => Promise<unknown>) => fn(em)),
      getRepository: em.getRepository,
      query: em.query,
    } as unknown as DataSource;

    // The stop now belongs to somebody else, and it moved at REASSIGNED_AT.
    const stops = {
      findOne: jest.fn().mockResolvedValue({
        id: STOP,
        driverId: OTHER_DRIVER,
        updatedAt: REASSIGNED_AT,
      } as unknown as Stop),
    } as unknown as Repository<Stop>;

    const service = new AttemptsService(
      dataSource,
      stops,
      { findOne: jest.fn() } as unknown as Repository<DeliveryAttempt>,
      { presignPut: jest.fn().mockResolvedValue('https://s3.test/put') } as unknown as S3Service,
      { projectStop: jest.fn() } as unknown as PodsProjectionService,
      { get: (_k: string, d: unknown) => d } as unknown as ConfigService,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );

    const dto = {
      clientAttemptId: CLIENT_ID,
      stopId: STOP,
      outcome: 'delivered_to_person',
      capturedAt,
      appVersion: '2.0.0',
      signature: { sizeBytes: 40_000 },
    } as unknown as CreateAttemptDto;

    return { service, dto, inserts };
  }

  it('accepts a capture made before the stop moved, and flags it', async () => {
    // 09:14, half an hour before dispatch reassigned it at 10:00.
    const { service, dto, inserts } = build('2026-08-12T09:14:00.000Z');

    const result = await service.create(user, dto);

    expect(result.conflict).toBe(true);
    expect(result.conflictReason).toContain('reassigned');

    const insert = inserts.find((q) => q.sql.includes('INSERT INTO delivery_attempts'));
    expect(insert).toBeDefined();
    // conflict=true and a reason are written with the row, not patched on
    // afterwards: they sit outside pod_app's UPDATE grant precisely so no
    // later code path can revise them.
    expect(insert?.params).toContain(true);
    expect(insert?.params.some((p) => typeof p === 'string' && p.includes('reassigned'))).toBe(
      true,
    );
    // And the driver who actually made it keeps the attribution.
    expect(insert?.params).toContain(DRIVER);
  });

  it('still refuses a capture made after the stop moved', async () => {
    // 10:30, half an hour after it stopped being this driver's work.
    const { service, dto } = build('2026-08-12T10:30:00.000Z');

    await expect(service.create(user, dto)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
