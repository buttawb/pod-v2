import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { S3Service } from '../src/modules/media/s3.service';

/**
 * The frozen v1 contract. The v1.4.2 fleet calls exactly these two routes;
 * these tests pin the response SHAPE (exact key sets, exact types) so any
 * accidental leak of new columns or renamed fields fails CI. Values vary
 * per seed; shapes must not.
 */
const STOP_KEYS = ['id', 'driver_id', 'address', 'postcode', 'location', 'sequence', 'created_at', 'pod'].sort();
const POD_KEYS = ['id', 'stop_id', 'delivered', 'photo_url', 'signature_url', 'location', 'note', 'created_at'].sort();

describe('v1 legacy contract (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;

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
        deviceFingerprint: `e2e-legacy-${randomUUID()}`,
      })
      .expect(200);
    token = login.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/stops returns the full history in the exact v1 shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/stops')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(150); // full history, not just today

    for (const stop of res.body.slice(0, 25)) {
      // Exact key set: new v2 columns (status, lat, lng, ...) must NOT leak.
      expect(Object.keys(stop).sort()).toEqual(STOP_KEYS);
      expect(typeof stop.id).toBe('string');
      expect(typeof stop.address).toBe('string');
      expect(typeof stop.postcode).toBe('string');
      expect(typeof stop.location).toBe('string');
      expect(typeof stop.sequence).toBe('number');
      if (stop.pod !== null) {
        expect(Object.keys(stop.pod).sort()).toEqual(POD_KEYS);
        expect(typeof stop.pod.delivered).toBe('boolean');
      }
    }
  });

  it('POST /api/stops/:id/pod keeps working and returns the v1 pod shape', async () => {
    const stops = await request(app.getHttpServer())
      .get('/api/v2/stops')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const stopId = stops.body.stops[10].id as string;

    // A run-unique marker keeps the assertion independent of rows left by
    // earlier runs against the same seeded database.
    const note = `handed to resident ${randomUUID()}`;
    const res = await request(app.getHttpServer())
      .post(`/api/stops/${stopId}/pod`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        delivered: true,
        photo_url: 'https://legacy-cdn.example.com/p.jpg',
        location: '51.5074,-0.1278',
        note,
      })
      .expect(201);

    expect(Object.keys(res.body).sort()).toEqual(POD_KEYS);
    expect(res.body.stop_id).toBe(stopId);
    expect(res.body.delivered).toBe(true);
    expect(res.body.photo_url).toBe('https://legacy-cdn.example.com/p.jpg');

    // Under the hood it became a v2 attempt with the raw body preserved.
    const attempts = (await dataSource.query(
      `SELECT source, outcome, raw_payload FROM delivery_attempts
       WHERE stop_id = $1 AND source = 'v1_compat' AND note = $2`,
      [stopId, note],
    )) as Array<{ source: string; outcome: string; raw_payload: Record<string, unknown> }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe('delivered_to_person');
    expect(attempts[0].raw_payload.note).toBe(note);
  });

  it('an identical v1 retry does not create a second attempt (derived idempotency)', async () => {
    const stops = await request(app.getHttpServer())
      .get('/api/v2/stops')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const stopId = stops.body.stops[11].id as string;
    const note = `no answer ${randomUUID()}`;
    const body = { delivered: false, location: '51.5,-0.1', note };

    await request(app.getHttpServer())
      .post(`/api/stops/${stopId}/pod`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/stops/${stopId}/pod`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);

    // Two identical requests seconds apart are one event, not two: the
    // derived key's time bucket dedupes the retry.
    const rows = (await dataSource.query(
      `SELECT count(*)::int AS n FROM delivery_attempts
       WHERE stop_id = $1 AND source = 'v1_compat' AND note = $2`,
      [stopId, note],
    )) as Array<{ n: number }>;
    expect(rows[0].n).toBe(1);
  });

  it('a v2 attempt projects into pods so v1 readers see the latest state', async () => {
    const stops = await request(app.getHttpServer())
      .get('/api/v2/stops')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const stopId = stops.body.stops[12].id as string;

    await request(app.getHttpServer())
      .post('/api/v2/attempts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientAttemptId: randomUUID(),
        stopId,
        outcome: 'refused',
        reasonCode: 'customer_refused',
        lat: 51.5,
        lng: -0.1,
        capturedAt: new Date().toISOString(),
        appVersion: '2.0.0',
      })
      .expect(200);

    const pods = (await dataSource.query(`SELECT delivered FROM pods WHERE stop_id = $1`, [
      stopId,
    ])) as Array<{ delivered: boolean }>;
    expect(pods).toHaveLength(1);
    expect(pods[0].delivered).toBe(false); // refused -> not delivered, visible to v1
  });
});
