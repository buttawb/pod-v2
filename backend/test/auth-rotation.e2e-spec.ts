import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/**
 * Refresh-token rotation under the real threat model: a courier app that
 * retries aggressively, force-quits mid-request, and talks to more than one
 * load-balanced instance. The invariant under test is "exactly one active
 * token per family, always" - without it, reuse/theft detection is
 * meaningless and drivers get logged out mid-shift.
 */
const sha256Hex = (plain: string) => createHash('sha256').update(plain).digest('hex');

describe('refresh rotation (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const login = async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v2/auth/driver/login')
      .send({
        employeeRef: 'EMP-TEST-001',
        password: 'TestDriver#2026',
        deviceFingerprint: `rotation-${randomUUID()}`,
      })
      .expect(200);
    return res.body.refreshToken as string;
  };

  const familyOf = async (refreshToken: string) => {
    const rows = (await dataSource.query(
      `SELECT family_id FROM refresh_tokens WHERE token_hash = $1`,
      [sha256Hex(refreshToken)],
    )) as Array<{ family_id: string }>;
    return rows[0]?.family_id;
  };

  const activeCount = async (familyId: string) => {
    const rows = (await dataSource.query(
      `SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id = $1 AND status = 'active'`,
      [familyId],
    )) as Array<{ n: number }>;
    return rows[0].n;
  };

  beforeAll(async () => {
    process.env.AI_ENABLED = 'false';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rotates on a normal refresh and leaves exactly one active token', async () => {
    const refreshToken = await login();
    const familyId = await familyOf(refreshToken);

    const res = await request(app.getHttpServer())
      .post('/api/v2/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(res.body.refreshToken).not.toBe(refreshToken);
    expect(await activeCount(familyId)).toBe(1);
  });

  it('concurrent refreshes of one token never double-mint and never log the driver out', async () => {
    const refreshToken = await login();
    const familyId = await familyOf(refreshToken);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer()).post('/api/v2/auth/refresh').send({ refreshToken }),
      ),
    );

    // Requests that land after the winner committed are indistinguishable
    // from a genuine lost-response replay, so they may also rotate; what
    // must never happen is a 401 (self-inflicted logout) or two live tokens.
    expect(responses.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(responses.some((r) => r.status === 200)).toBe(true);
    expect(await activeCount(familyId)).toBe(1);

    // The newest issued token is the live one. (The client is single-flight
    // per device, so it only ever holds the newest response; the burst here
    // is the pathological server-side case.)
    const issued = responses
      .filter((r) => r.status === 200)
      .map((r) => r.body.refreshToken as string);
    const live = (await dataSource.query(
      `SELECT count(*)::int AS n FROM refresh_tokens
       WHERE family_id = $1 AND status = 'active'
         AND token_hash = ANY($2::text[])`,
      [familyId, issued.map((t) => sha256Hex(t))],
    )) as Array<{ n: number }>;
    expect(live[0].n).toBe(1);
  });

  it('a lost response (sequential replay inside the grace window) recovers with a fresh pair', async () => {
    const refreshToken = await login();
    const familyId = await familyOf(refreshToken);

    const first = await request(app.getHttpServer())
      .post('/api/v2/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    // Client never received `first`; it retries the original token.
    const replay = await request(app.getHttpServer())
      .post('/api/v2/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(replay.body.refreshToken).not.toBe(first.body.refreshToken);
    expect(await activeCount(familyId)).toBe(1);

    // The superseded successor must be dead, and using it contains the family.
    await request(app.getHttpServer())
      .post('/api/v2/auth/refresh')
      .send({ refreshToken: first.body.refreshToken })
      .expect(401);
  });

  it('reuse after the grace window revokes the whole family (theft containment)', async () => {
    const refreshToken = await login();
    const familyId = await familyOf(refreshToken);

    await request(app.getHttpServer())
      .post('/api/v2/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    // Age the rotation past the grace window instead of sleeping.
    await dataSource.query(
      `UPDATE refresh_tokens SET rotated_at = now() - interval '10 minutes'
       WHERE family_id = $1 AND status = 'rotated'`,
      [familyId],
    );

    await request(app.getHttpServer())
      .post('/api/v2/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    expect(await activeCount(familyId)).toBe(0);
  });
});
