import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { REDIRECT_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import { IS_PUBLIC_KEY, JwtAuthGuard, ROLES_KEY } from '../../common/auth/jwt-auth.guard';
import { Audience } from '../../common/auth/jwt-payload';
import type { JwtPayload, Role } from '../../common/auth/jwt-payload';
import { AttemptPhoto } from '../attempts/entities/attempt-photo.entity';
import type { DeliveryAttempt } from '../attempts/entities/delivery-attempt.entity';
import { MediaController } from './media.controller';
import type { S3Service } from './s3.service';

/**
 * Delivery photos are a customer's doorway, their parcel and sometimes their
 * face. The bucket is private, so the only way to see one is through this
 * controller, which makes this file the whole of the access control for that
 * evidence. Two properties have to hold together: the route cannot be reached
 * without a token, and a token only reaches the attempts its holder owns. Each
 * is useless alone, so both are pinned here, along with the delivery mechanism
 * that keeps a leaked link from outliving the request it was issued for.
 */
describe('MediaController (evidence is authenticated and owner scoped)', () => {
  const OWNER = 'a1c1d6f2-0d51-4f39-9a3a-4b7f0a2b1c01';
  const OTHER_DRIVER = 'b2d2e7a3-1e62-4a4a-8b4b-5c8f1b3c2d02';
  const OFFICE_USER = 'c3e3f8b4-2f73-4b5b-9c5c-6d9a2c4d3e03';
  const ATTEMPT_ID = 'd4f4a9c5-3a84-4c6c-8d6d-7eab3d5e4f04';
  const PHOTO_KEY = `attempts/${ATTEMPT_ID}/photo/0.jpg`;
  const SIGNATURE_KEY = `attempts/${ATTEMPT_ID}/signature.png`;

  const reflector = new Reflector();
  const asUser = (sub: string, role: Role): JwtPayload => ({ sub, role, aud: Audience.V2 });

  const build = (
    overrides: {
      attempt?: Partial<DeliveryAttempt> | null;
      photo?: Partial<AttemptPhoto> | null;
    } = {},
  ) => {
    // Any write at all is a failure here. A presigned URL that gets persisted
    // outlives the single request that was authorised for it, which is the
    // exact hazard the redirect design exists to avoid.
    const writes = {
      save: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    };

    const attemptRow =
      overrides.attempt === undefined
        ? { id: ATTEMPT_ID, driverId: OWNER, signatureS3Key: SIGNATURE_KEY }
        : overrides.attempt;
    const photoRow =
      overrides.photo === undefined
        ? { attemptId: ATTEMPT_ID, photoIndex: 0, s3Key: PHOTO_KEY }
        : overrides.photo;

    const attempts = { ...writes, findOne: jest.fn().mockResolvedValue(attemptRow) };
    const photos = { ...writes, findOne: jest.fn().mockResolvedValue(photoRow) };

    const query = jest.fn();
    const dataSource = {
      query,
      getRepository: jest.fn((entity: unknown) => (entity === AttemptPhoto ? photos : attempts)),
    } as unknown as DataSource;

    // Every call hands back a different URL, so a test cannot pass by way of a
    // remembered one.
    let minted = 0;
    const presignGet = jest.fn((key: string) => {
      minted += 1;
      return Promise.resolve(`https://bucket.s3.test/${key}?X-Amz-Expires=300&X-Amz-Signature=s${minted}`);
    });
    const s3 = { presignGet } as unknown as S3Service;

    return { controller: new MediaController(dataSource, s3), presignGet, writes, query };
  };

  describe('the route is closed by default', () => {
    it('carries the role restriction and never opts out of the global guard', () => {
      expect(reflector.get<Role[]>(ROLES_KEY, MediaController)).toEqual(['driver', 'office']);

      // Read the way JwtAuthGuard reads it. Deleting either decorator, or
      // adding @Public() to sneak a route past the guard, lands here.
      expect(reflector.get<boolean>(IS_PUBLIC_KEY, MediaController)).toBeUndefined();
      for (const handler of [MediaController.prototype.photo, MediaController.prototype.signature]) {
        expect(reflector.get<boolean>(IS_PUBLIC_KEY, handler)).toBeUndefined();
      }
    });

    const guardFor = (token: Record<string, unknown>) =>
      new JwtAuthGuard({ verifyAsync: () => Promise.resolve(token) } as never, reflector);

    // The real controller and the real Reflector, so the guard resolves the
    // decorators actually present on this class rather than a restatement.
    const contextFor = (headers: Record<string, string>) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers, query: {} }) }),
        getHandler: () => MediaController.prototype.photo,
        getClass: () => MediaController,
      }) as unknown as ExecutionContext;

    it('turns away a request carrying no token', async () => {
      await expect(
        guardFor({ sub: OWNER, role: 'driver' }).canActivate(contextFor({})),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('turns away a role the controller does not list', async () => {
      // Only two roles exist today, so the allow list earns its keep the day a
      // third one is minted and nobody revisits this controller.
      await expect(
        guardFor({ sub: 'x', role: 'auditor', aud: Audience.V2 }).canActivate(
          contextFor({ authorization: 'Bearer stub' }),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('admits a valid driver token', async () => {
      await expect(
        guardFor({ sub: OWNER, role: 'driver', aud: Audience.V2 }).canActivate(
          contextFor({ authorization: 'Bearer stub' }),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('a token only reaches its own evidence', () => {
    it('refuses a driver reaching for another driver photo', async () => {
      const { controller, presignGet } = build();

      await expect(
        controller.photo(asUser(OTHER_DRIVER, 'driver'), ATTEMPT_ID, 0),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Order matters: minting first and refusing afterwards would put a
      // working URL into the process for an unauthorised caller.
      expect(presignGet).not.toHaveBeenCalled();
    });

    it('refuses a driver reaching for another driver signature', async () => {
      const { controller, presignGet } = build();

      await expect(
        controller.signature(asUser(OTHER_DRIVER, 'driver'), ATTEMPT_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(presignGet).not.toHaveBeenCalled();
    });

    it('serves the driver who captured the attempt', async () => {
      const { controller, presignGet } = build();

      await expect(controller.photo(asUser(OWNER, 'driver'), ATTEMPT_ID, 0)).resolves.toEqual({
        url: expect.stringContaining(PHOTO_KEY),
      });
      expect(presignGet).toHaveBeenCalledWith(PHOTO_KEY);
    });

    it('serves an office user any driver attempt', async () => {
      // Office is the support desk answering "where is my parcel", so the
      // owner rule is deliberately driver only.
      const { controller, presignGet } = build();

      await expect(
        controller.signature(asUser(OFFICE_USER, 'office'), ATTEMPT_ID),
      ).resolves.toEqual({ url: expect.stringContaining(SIGNATURE_KEY) });
      expect(presignGet).toHaveBeenCalledWith(SIGNATURE_KEY);
    });

    it('404s an unknown attempt', async () => {
      const { controller, presignGet } = build({ attempt: null });

      await expect(
        controller.photo(asUser(OWNER, 'driver'), ATTEMPT_ID, 0),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(presignGet).not.toHaveBeenCalled();
    });

    it('404s rather than signing a key that is not there', async () => {
      // Presigning a null key yields a URL pointing at the bucket itself.
      const { controller, presignGet } = build({
        attempt: { id: ATTEMPT_ID, driverId: OWNER, signatureS3Key: null },
      });

      await expect(
        controller.signature(asUser(OWNER, 'driver'), ATTEMPT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(presignGet).not.toHaveBeenCalled();
    });
  });

  describe('the bytes never come through the API', () => {
    it('redirects to a destination supplied per request', () => {
      for (const handler of [MediaController.prototype.photo, MediaController.prototype.signature]) {
        const redirect = reflector.get<{ statusCode: number; url: string }>(
          REDIRECT_METADATA,
          handler,
        );
        expect(redirect.statusCode).toBe(302);
        // No baked in destination: the only URL is the one the handler returns
        // after the authz check has passed.
        expect(redirect.url).toBeFalsy();
      }
    });

    it('answers with a URL and nothing else', async () => {
      const { controller } = build();

      const result = await controller.photo(asUser(OWNER, 'driver'), ATTEMPT_ID, 0);

      // Any other key in the body means image bytes, or a copy of them, are
      // being proxied through the API instead of fetched straight from S3.
      expect(Object.keys(result)).toEqual(['url']);
    });

    it('mints a fresh URL each time and stores none', async () => {
      const { controller, presignGet, writes, query } = build();

      const first = await controller.photo(asUser(OWNER, 'driver'), ATTEMPT_ID, 0);
      const second = await controller.photo(asUser(OWNER, 'driver'), ATTEMPT_ID, 0);

      expect(presignGet).toHaveBeenCalledTimes(2);
      expect(second.url).not.toBe(first.url);

      // A stored URL is a credential with no expiry attached to a row anyone
      // with read access can see.
      for (const write of Object.values(writes)) {
        expect(write).not.toHaveBeenCalled();
      }
      expect(query).not.toHaveBeenCalled();
    });
  });
});
