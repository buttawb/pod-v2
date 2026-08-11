import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { attemptBody, authHeaders, BASE_URL, driverFor, login, uuid } from './lib.js';

/**
 * Morning burst: 06:30-08:00 every driver signs in, pulls their route, and
 * flushes whatever the overnight queue still holds.
 *
 * The idempotency contract is asserted under load, not just in a unit test:
 * 10% of iterations deliberately re-send an attempt with the SAME
 * client_attempt_id, which is what a retrying app on a flaky connection
 * does. Every replay must come back deduplicated, and a post-run SQL check
 * must find exactly one row per key.
 */
const dedupedReplays = new Counter('deduped_replays');
const unexpectedDuplicates = new Counter('unexpected_duplicates');

export const options = {
  scenarios: {
    morning_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '5m', target: 300 },
        { duration: '3m', target: 300 },
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.005'],
    'http_req_duration{endpoint:today-list}': ['p(95)<400'],
    'http_req_duration{endpoint:attempt-submit}': ['p(95)<400'],
    'http_req_duration{endpoint:sync}': ['p(95)<250'],
    checks: ['rate>0.99'],
    unexpected_duplicates: ['count==0'],
  },
};

export default function morningBurst() {
  const token = login(`${__VU}-${__ITER}`, driverFor(__VU));
  if (!token) return;

  const stopsResponse = http.get(
    `${BASE_URL}/api/v2/stops`,
    authHeaders(token, 'today-list'),
  );
  check(stopsResponse, { 'stops 200': (r) => r.status === 200 });
  if (stopsResponse.status !== 200) return;

  const stops = stopsResponse.json('stops');
  if (!stops || stops.length === 0) return;

  const stop = stops[Math.floor(Math.random() * stops.length)];
  const clientAttemptId = uuid();

  const submit = http.post(
    `${BASE_URL}/api/v2/attempts`,
    attemptBody(clientAttemptId, stop.id),
    authHeaders(token, 'attempt-submit'),
  );
  check(submit, {
    'attempt accepted': (r) => r.status === 200,
    'first submit is not a dedupe': (r) => r.status !== 200 || r.json('deduplicated') === false,
  });

  // The retry path: same key, same payload, exactly as an app resending
  // after a lost response would.
  if (Math.random() < 0.1 && submit.status === 200) {
    const replay = http.post(
      `${BASE_URL}/api/v2/attempts`,
      attemptBody(clientAttemptId, stop.id),
      authHeaders(token, 'attempt-replay'),
    );
    const isDeduped = replay.status === 200 && replay.json('deduplicated') === true;
    check(replay, { 'replay is deduplicated, not a second record': () => isDeduped });
    if (isDeduped) dedupedReplays.add(1);
    else unexpectedDuplicates.add(1);
  }

  const sync = http.get(`${BASE_URL}/api/v2/sync`, authHeaders(token, 'sync'));
  check(sync, { 'sync 200': (r) => r.status === 200 });

  sleep(1 + Math.random() * 2);
}
