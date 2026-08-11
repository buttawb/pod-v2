import http from 'k6/http';
import { check } from 'k6';
import { attemptBody, authHeaders, BASE_URL, FLEET, login, uuid } from './lib.js';

/**
 * Steady state, modelled from the brief's own numbers:
 *   3,000 drivers x 150 stops = 450,000 attempts/day
 *   450,000 / 8h = ~15.6 attempts/s
 *   x ~3.4 requests per attempt (submit + presign + finalize) = ~53 rps
 *   plus route refreshes and config polls = ~115 rps overall
 *
 * Deliberately an OPEN model (constant-arrival-rate): arrivals do not slow
 * down when the server does, so degradation shows up as a p95 blowout
 * instead of silently reduced load. A closed VU loop would flatter a
 * struggling server by backing off for it.
 */
export const options = {
  scenarios: {
    steady_day: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE ?? 60),
      timeUnit: '1s',
      duration: __ENV.DURATION ?? '5m',
      preAllocatedVUs: 200,
      maxVUs: 600,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.005'],
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    'http_req_duration{endpoint:attempt-submit}': ['p(95)<400'],
    'http_req_duration{endpoint:presign}': ['p(95)<200'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  // One session per seeded driver, so throughput is spread across the fleet
  // exactly as it is in production rather than concentrated on one identity.
  return FLEET.map((employeeRef, index) => {
    const token = login(`steady-${index}`, employeeRef);
    const stops = http
      .get(`${BASE_URL}/api/v2/stops`, authHeaders(token, 'today-list'))
      .json('stops');
    return { token, stopIds: (stops ?? []).map((s) => s.id) };
  }).filter((session) => session.stopIds.length > 0);
}

export default function steadyDay(sessions) {
  const session = sessions[__VU % sessions.length];
  const stopId = session.stopIds[Math.floor(Math.random() * session.stopIds.length)];
  const clientAttemptId = uuid();

  const submit = http.post(
    `${BASE_URL}/api/v2/attempts`,
    attemptBody(clientAttemptId, stopId),
    authHeaders(session.token, 'attempt-submit'),
  );
  check(submit, { 'attempt accepted': (r) => r.status === 200 });

  // Re-requesting upload URLs is the app's normal retry path and the only
  // presign work the API does per attempt.
  const presign = http.post(
    `${BASE_URL}/api/v2/attempts/${clientAttemptId}/upload-urls`,
    null,
    authHeaders(session.token, 'presign'),
  );
  check(presign, { 'presign 200/201': (r) => r.status === 200 || r.status === 201 });
}
