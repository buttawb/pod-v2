import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { S3Service } from '../src/modules/media/s3.service';
import { describeWithDb } from './requires-db';

/**
 * The flagship test: proves the unique index on client_attempt_id is the
 * cross-instance serialization point. Five CONCURRENT submissions of the
 * same payload (what two LB instances receiving retries look like) must
 * produce exactly one row, and every caller must get an equivalent success.
 *
 * Runs against the real seeded Postgres; S3 is stubbed (presign is not what
 * is under test, and evidence acceptance must not depend on S3 anyway).
 */
describeWithDb('attempt submission idempotency (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  let stopId: string;

  beforeAll(async () => {
    process.env.AI_ENABLED = 'false';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(S3Service)
      .useValue({
        presignPut: () => Promise.resolve('https://s3.stub/put'),
        presignGet: () => Promise.resolve('https://s3.stub/get'),
        headObject: () => Promise.resolve(null),
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = app.get(DataSource);

    const login = await request(app.getHttpServer())
      .post('/api/v2/auth/driver/login')
      .send({
        employeeRef: 'EMP-TEST-001',
        password: 'TestDriver#2026',
        deviceFingerprint: `e2e-${randomUUID()}`,
        appVersion: '2.0.0',
      })
      .expect(200);
    token = login.body.accessToken as string;

    const stops = await request(app.getHttpServer())
      .get('/api/v2/stops')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // Use a late-sequence stop so other tests' writes never collide.
    stopId = stops.body.stops[stops.body.stops.length - 1].id as string;
  });

  afterAll(async () => {
    await app.close();
  });

  const payload = (clientAttemptId: string, note = 'by the shed') => ({
    clientAttemptId,
    stopId,
    outcome: 'left_safe_place',
    note,
    lat: 51.5,
    lng: -0.1,
    gpsAccuracyM: 10,
    capturedAt: new Date().toISOString(),
    appVersion: '2.0.0',
    photos: [{ index: 0, sizeBytes: 100_000 }],
  });

  it('five concurrent submissions of one payload create exactly one row', async () => {
    const clientAttemptId = randomUUID();
    const body = payload(clientAttemptId);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/api/v2/attempts')
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.clientAttemptId).toBe(clientAttemptId);
    }
    expect(responses.filter((r) => r.body.deduplicated === false)).toHaveLength(1);
    expect(responses.filter((r) => r.body.deduplicated === true)).toHaveLength(4);

    const rows = (await dataSource.query(
      `SELECT count(*)::int AS n FROM delivery_attempts WHERE client_attempt_id = $1`,
      [clientAttemptId],
    )) as Array<{ n: number }>;
    expect(rows[0].n).toBe(1);

    const manifest = (await dataSource.query(
      `SELECT count(*)::int AS n FROM attempt_photos ap
       JOIN delivery_attempts a ON a.id = ap.attempt_id
       WHERE a.client_attempt_id = $1`,
      [clientAttemptId],
    )) as Array<{ n: number }>;
    expect(manifest[0].n).toBe(1); // manifest not duplicated either
  });

  it('sequential replay returns deduplicated with fresh upload targets', async () => {
    const clientAttemptId = randomUUID();
    const body = payload(clientAttemptId);

    const first = await request(app.getHttpServer())
      .post('/api/v2/attempts')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);
    expect(first.body.deduplicated).toBe(false);
    expect(first.body.evidenceStatus).toBe('pending_media');

    const replay = await request(app.getHttpServer())
      .post('/api/v2/attempts')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);
    expect(replay.body.deduplicated).toBe(true);
    expect(replay.body.attemptId).toBe(first.body.attemptId);
    expect(replay.body.uploads).toHaveLength(1); // still owed, so re-offered
  });

  it('same key with a DIFFERENT payload is a 422 tripwire, never silently resolved', async () => {
    const clientAttemptId = randomUUID();
    await request(app.getHttpServer())
      .post('/api/v2/attempts')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(clientAttemptId))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/api/v2/attempts')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(clientAttemptId, 'a DIFFERENT note'))
      .expect(422);
    expect(res.body.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('evidence-less outcomes are complete immediately (attempt JSON is the whole proof)', async () => {
    const clientAttemptId = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/api/v2/attempts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientAttemptId,
        stopId,
        outcome: 'refused',
        reasonCode: 'customer_refused',
        lat: 51.5,
        lng: -0.1,
        capturedAt: new Date().toISOString(),
        appVersion: '2.0.0',
      })
      .expect(200);
    expect(res.body.evidenceStatus).toBe('complete');
    expect(res.body.uploads).toHaveLength(0);
  });

  it("another driver's stop is a 403 (IDOR guard)", async () => {
    const otherStop = (await dataSource.query(
      `SELECT id FROM stops WHERE driver_id <> (SELECT id FROM drivers WHERE employee_ref = 'EMP-TEST-001') LIMIT 1`,
    )) as Array<{ id: string }>;

    await request(app.getHttpServer())
      .post('/api/v2/attempts')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...payload(randomUUID()), stopId: otherStop[0].id })
      .expect(403);
  });
});
