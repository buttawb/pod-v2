import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.BASE_URL ?? 'https://18.139.240.68.sslip.io';

const DRIVER_REF = __ENV.DRIVER_REF ?? 'EMP-TEST-001';
const DRIVER_PASSWORD = __ENV.DRIVER_PASSWORD ?? 'TestDriver#2026';

export function login(deviceSuffix) {
  const response = http.post(
    `${BASE_URL}/api/v2/auth/driver/login`,
    JSON.stringify({
      employeeRef: DRIVER_REF,
      password: DRIVER_PASSWORD,
      deviceFingerprint: `k6-${deviceSuffix}`,
      appVersion: '2.0.0',
    }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login' } },
  );
  check(response, { 'login 200': (r) => r.status === 200 });
  return response.status === 200 ? response.json('accessToken') : null;
}

export function authHeaders(token, endpoint) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-App-Version': '2.0.0',
    },
    tags: { endpoint },
  };
}

/** RFC 4122 v4, generated client-side exactly as the app does. */
export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function attemptBody(clientAttemptId, stopId) {
  return JSON.stringify({
    clientAttemptId,
    stopId,
    outcome: 'left_safe_place',
    note: 'left by the side door under the porch',
    lat: 51.5 + Math.random() * 0.05,
    lng: -0.12 + Math.random() * 0.05,
    gpsAccuracyM: 8,
    capturedAt: new Date().toISOString(),
    appVersion: '2.0.0',
    photos: [{ index: 0, sizeBytes: 420000 }],
  });
}
