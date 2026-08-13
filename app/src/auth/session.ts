import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL, APP_VERSION } from '../config';
import { getMeta, setMeta } from '../db/schema';

const ACCESS_KEY = 'pod.accessToken';
const REFRESH_KEY = 'pod.refreshToken';
const DEVICE_KEY = 'pod.deviceFingerprint';

export interface Session {
  accessToken: string | null;
  refreshToken: string | null;
  driverId: string;
  driverName: string;
}

export const SessionState = {
  Ok: 'ok',
  NeedsReauth: 'needs_reauth',
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/**
 * Tokens live in the Keystore-backed secure store, but driver identity is
 * mirrored into SQLite on purpose: attempt attribution and fully-offline
 * operation must never depend on a token being valid or even present.
 */
export async function getSession(): Promise<Session | null> {
  const driverId = await getMeta('driver_id');
  const driverName = await getMeta('driver_name');
  if (!driverId) return null;

  return {
    accessToken: await SecureStore.getItemAsync(ACCESS_KEY),
    refreshToken: await SecureStore.getItemAsync(REFRESH_KEY),
    driverId,
    driverName: driverName ?? 'Driver',
  };
}

export async function getDeviceFingerprint(): Promise<string> {
  let fingerprint = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!fingerprint) {
    // A random install ID, not a hardware identifier: we need to tell
    // devices apart, not to identify the handset itself.
    fingerprint = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_KEY, fingerprint);
  }
  return fingerprint;
}

export async function login(employeeRef: string, password: string): Promise<void> {
  const deviceFingerprint = await getDeviceFingerprint();

  const response = await fetch(`${API_BASE_URL}/api/v2/auth/driver/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-App-Version': APP_VERSION },
    body: JSON.stringify({ employeeRef, password, deviceFingerprint, appVersion: APP_VERSION }),
  });

  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Wrong ID or password' : 'Sign in failed');
  }

  const body = (await response.json()) as {
    accessToken: string;
    refreshToken: string;
    driver: { id: string; displayName: string };
  };

  const previousDriverId = await getMeta('driver_id');
  await SecureStore.setItemAsync(ACCESS_KEY, body.accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, body.refreshToken);
  await setMeta('driver_id', body.driver.id);
  await setMeta('driver_name', body.driver.displayName);
  await setMeta('session_state', SessionState.Ok);

  if (previousDriverId && previousDriverId !== body.driver.id) {
    // Shared device: the previous driver's unsent evidence stays on disk and
    // attributed to them. Deleting another person's legal evidence is never an
    // acceptable side effect of signing in.
    //
    // What actually holds that line is the driver predicate in
    // claimNextWorkable (db/attempts-repo.ts), not this row: the queue only
    // ever offers the signed-in driver's own attempts, so the previous
    // driver's work cannot be uploaded under the new driver's token. This is a
    // breadcrumb recording WHO is parked, for a "someone else has unsent work
    // on this phone" surface that is not built. It is not the mechanism, and
    // the comment used to imply otherwise.
    await setMeta('quarantined_driver_id', previousDriverId);
  }
}

/**
 * Signing out clears credentials only. Evidence and its files are left
 * untouched: there is no destructive path anywhere in the auth flow.
 */
export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
  await setMeta('session_state', SessionState.NeedsReauth);
}

export async function clearAccessToken(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_KEY);
}

let inFlightRefresh: Promise<boolean> | null = null;

/**
 * Single-flight: concurrent 401s share one refresh. The server treats a
 * duplicate in-flight refresh as a retryable 409, so racing it would only
 * produce noise; sharing the promise avoids the race entirely.
 */
export async function refreshSession(): Promise<boolean> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    try {
      const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
      if (!refreshToken) {
        await setMeta('session_state', SessionState.NeedsReauth);
        return false;
      }

      const response = await fetch(`${API_BASE_URL}/api/v2/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Version': APP_VERSION },
        body: JSON.stringify({ refreshToken }),
      });

      if (response.status === 409) return false; // another refresh is in flight; retry later
      if (!response.ok) {
        // Expired or revoked: freeze sync, keep every byte of evidence.
        await setMeta('session_state', SessionState.NeedsReauth);
        return false;
      }

      const body = (await response.json()) as { accessToken: string; refreshToken: string };
      // Persist BOTH before using either: a kill here must not strand us
      // with a token pair the server has already rotated past.
      await SecureStore.setItemAsync(ACCESS_KEY, body.accessToken);
      await SecureStore.setItemAsync(REFRESH_KEY, body.refreshToken);
      await setMeta('session_state', SessionState.Ok);
      return true;
    } catch {
      return false; // offline: not a session problem, just no signal
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

export async function getSessionState(): Promise<SessionState> {
  return ((await getMeta('session_state')) as SessionState | null) ?? SessionState.Ok;
}
