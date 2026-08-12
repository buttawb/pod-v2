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
 * The frozen v1.4.2 contract, as the client specified it.
 *
 * These tests are the tripwire, not documentation: the live fleet cannot take
 * an app update, so any drift here is a fleet outage rather than a failing
 * build. They pin the exact request bodies, the exact response key sets, the
 * status codes, the token lifetime, and the two properties that are invisible
 * in a shape assertion: that GET /api/stops is unbounded, and that a pod's
 * identity and timestamp never move once v1 has seen them.
 *
 * v1 auth is deliberately its own surface: these use POST /api/auth/login,
 * never the v2 endpoint, because a token minted for v2 must not open a v1
 * route.
 */
const STOP_KEYS = ['id', 'driver_id', 'address', 'postcode', 'location', 'sequence', 'created_at', 'pod'].sort();
const POD_KEYS = ['id', 'stop_id', 'delivered', 'photo_url', 'signature_url', 'location', 'note', 'created_at'].sort();

/** The seed derives this deterministically from the employee ref. */
const V1_EMAIL = 'EMP-TEST-001@fleet.local';
const V1_PASSWORD = 'TestDriver#2026';

function decodeJwt(token: string): { exp: number; iat: number; aud?: string; sub: string } {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as never;
}

describeWithDb('v1 legacy contract (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  let v2Token: string;

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
      .post('/api/auth/login')
      .send({ email: V1_EMAIL, password: V1_PASSWORD })
      .expect(201);
    token = login.body.token as string;

    // v2 token only for picking fixtures through the v2 API; never sent to a
    // v1 route (there is a test below asserting it would be rejected).
    const v2Login = await request(app.getHttpServer())
      .post('/api/v2/auth/driver/login')
      .send({
        employeeRef: 'EMP-TEST-001',
        password: V1_PASSWORD,
        deviceFingerprint: `e2e-legacy-${randomUUID()}`,
      })
      .expect(200);
    v2Token = v2Login.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  const pickStopId = async (index: number): Promise<string> => {
    const stops = await request(app.getHttpServer())
      .get('/api/v2/stops')
      .set('Authorization', `Bearer ${v2Token}`)
      .expect(200);
    return stops.body.stops[index].id as string;
  };

  describe('POST /api/auth/login', () => {
    it('takes { email, password } and returns exactly { token }', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: V1_EMAIL, password: V1_PASSWORD })
        .expect(201);

      // Exactly one key: a v1.4.2 handset parses this body and anything extra
      // is surface we can never remove again.
      expect(Object.keys(res.body)).toEqual(['token']);
      expect(typeof res.body.token).toBe('string');
    });

    it('issues a 24h token with no refresh token', async () => {
      const claims = decodeJwt(token);
      expect(claims.exp - claims.iat).toBe(86400);
      expect(claims.sub).toEqual(expect.any(String));
    });

    it('rejects bad credentials without revealing which field was wrong', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: V1_EMAIL, password: 'wrong' })
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'nobody@fleet.local', password: V1_PASSWORD })
        .expect(401);
    });

    it('does not accept a v2 token on a v1 route', async () => {
      await request(app.getHttpServer())
        .get('/api/stops')
        .set('Authorization', `Bearer ${v2Token}`)
        .expect(401);
    });
  });

  describe('GET /api/stops', () => {
    it('returns the full history in the exact v1 shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/stops')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);

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

    it('is unbounded: a stop from before today is still returned', async () => {
      // Seeded counts cannot prove this. A row-count assertion passes just as
      // happily if someone adds a "today" filter, so the test plants a stop in
      // the past and demands it back. v1 filters to today client-side.
      const [driver] = (await dataSource.query(
        `SELECT id FROM drivers WHERE employee_ref = 'EMP-TEST-001'`,
      )) as Array<{ id: string }>;

      const marker = `history-${randomUUID()}`;
      const [planted] = (await dataSource.query(
        `INSERT INTO stops (driver_id, address, postcode, location, sequence, created_at, updated_at)
         VALUES ($1, $2, 'E1 6AN', '51.5,-0.1', 9999, now() - interval '9 days', now() - interval '9 days')
         RETURNING id`,
        [driver.id, marker],
      )) as Array<{ id: string }>;

      const res = await request(app.getHttpServer())
        .get('/api/stops')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toContain(planted.id);
    });

    it('takes no query parameters: paging arguments are ignored, not honoured', async () => {
      const plain = await request(app.getHttpServer())
        .get('/api/stops')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const paged = await request(app.getHttpServer())
        .get('/api/stops?limit=5&offset=10&cursor=abc')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(paged.body.length).toBe(plain.body.length);
    });
  });

  describe('POST /api/stops/:id/pod', () => {
    it('returns 201 with the created pod, and v1 can read id and created_at', async () => {
      const stopId = await pickStopId(10);
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
      // The two fields v1.4.2 actually reads off the response.
      expect(typeof res.body.id).toBe('string');
      expect(Number.isNaN(Date.parse(res.body.created_at))).toBe(false);

      // Under the hood it became a v2 attempt with the raw body preserved.
      const attempts = (await dataSource.query(
        `SELECT source, outcome, raw_payload FROM delivery_attempts
         WHERE stop_id = $1 AND source = 'v1_compat' AND note = $2`,
        [stopId, note],
      )) as Array<{ source: string; outcome: string; raw_payload: Record<string, unknown> }>;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].outcome).toBe('left_safe_place');
      expect(attempts[0].raw_payload.note).toBe(note);
    });

    it('returns 409 on a duplicate submission for the same stop', async () => {
      const stopId = await pickStopId(11);
      const body = { delivered: false, location: '51.5,-0.1', note: `no answer ${randomUUID()}` };

      await request(app.getHttpServer())
        .post(`/api/stops/${stopId}/pod`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      // v1.4.2 shows a generic error on 409. Succeeding here would tell the
      // handset a second POD exists when the stop can only ever have one.
      await request(app.getHttpServer())
        .post(`/api/stops/${stopId}/pod`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(409);

      // The conflict is a surface behaviour; underneath, the derived
      // idempotency key still means one event wrote one attempt.
      const rows = (await dataSource.query(
        `SELECT count(*)::int AS n FROM delivery_attempts
         WHERE stop_id = $1 AND source = 'v1_compat' AND note = $2`,
        [stopId, body.note],
      )) as Array<{ n: number }>;
      expect(rows[0].n).toBe(1);
    });

    it('maps the v1 boolean to the outcome its evidence actually supports', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ delivered: true, signature_url: 'https://legacy-cdn.example.com/s.png' }, 'delivered_to_person'],
        [{ delivered: true, photo_url: 'https://legacy-cdn.example.com/p.jpg' }, 'left_safe_place'],
        [{ delivered: false }, 'no_answer_carded'],
      ];

      for (const [index, [body, expected]] of cases.entries()) {
        const stopId = await pickStopId(20 + index);
        const note = `mapping ${randomUUID()}`;
        await request(app.getHttpServer())
          .post(`/api/stops/${stopId}/pod`)
          .set('Authorization', `Bearer ${token}`)
          .send({ ...body, location: '51.5,-0.1', note })
          .expect(201);

        const rows = (await dataSource.query(
          `SELECT outcome, evidence_status FROM delivery_attempts WHERE note = $1`,
          [note],
        )) as Array<{ outcome: string; evidence_status: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].outcome).toBe(expected);
      }
    });

    it('does not claim complete evidence for a v1 payload that carried none', async () => {
      const stopId = await pickStopId(25);
      const note = `no evidence ${randomUUID()}`;

      await request(app.getHttpServer())
        .post(`/api/stops/${stopId}/pod`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delivered: true, location: '51.5,-0.1', note })
        .expect(201);

      const rows = (await dataSource.query(
        `SELECT evidence_status FROM delivery_attempts WHERE note = $1`,
        [note],
      )) as Array<{ evidence_status: string }>;
      expect(rows[0].evidence_status).not.toBe('complete');
    });
  });

  describe('the pods projection v1 reads', () => {
    it('a v2 attempt projects into pods so v1 readers see the latest state', async () => {
      const stopId = await pickStopId(12);

      await request(app.getHttpServer())
        .post('/api/v2/attempts')
        .set('Authorization', `Bearer ${v2Token}`)
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

    it('never moves a pod id or created_at once v1 has seen them', async () => {
      const stopId = await pickStopId(13);

      // v1 records a delivery and reads back the pod identity it will keep.
      const first = await request(app.getHttpServer())
        .post(`/api/stops/${stopId}/pod`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delivered: true, location: '51.5,-0.1', note: `first ${randomUUID()}` })
        .expect(201);
      const seenId = first.body.id as string;
      const seenCreatedAt = first.body.created_at as string;

      // A later v2 attempt re-projects the same stop.
      await request(app.getHttpServer())
        .post('/api/v2/attempts')
        .set('Authorization', `Bearer ${v2Token}`)
        .send({
          clientAttemptId: randomUUID(),
          stopId,
          outcome: 'refused',
          reasonCode: 'customer_refused',
          lat: 51.5,
          lng: -0.1,
          capturedAt: new Date(Date.now() + 60_000).toISOString(),
          appVersion: '2.0.0',
        })
        .expect(200);

      const [pod] = (await dataSource.query(
        `SELECT id, created_at FROM pods WHERE stop_id = $1`,
        [stopId],
      )) as Array<{ id: string; created_at: Date }>;

      // The content may move with the latest attempt; the identity and the
      // moment v1 was told the POD came into existence may not. A v1 client
      // that stored created_at would otherwise silently disagree with us.
      expect(pod.id).toBe(seenId);
      expect(new Date(pod.created_at).toISOString()).toBe(new Date(seenCreatedAt).toISOString());
    });
  });
});
