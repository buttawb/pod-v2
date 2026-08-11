import { getSession, refreshSession, clearAccessToken } from '../auth/session';
import { recordVersionHeaders } from '../version/version-gate';

import { API_BASE_URL, APP_VERSION } from '../config';

export { API_BASE_URL, APP_VERSION };

const REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export class NetworkError extends Error {
  constructor(readonly timedOut: boolean, message: string) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  auth?: boolean;
  /** Internal: prevents an infinite refresh loop on a 401 that survives refresh. */
  isRetryAfterRefresh?: boolean;
}

/**
 * Every response carries the version policy headers, so a mid-shift policy
 * change is noticed on the next sync rather than at the next config poll.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options;

  const headers: Record<string, string> = {
    'X-App-Version': APP_VERSION,
    'X-Platform': 'android',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const session = await getSession();
    if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'AbortError';
    throw new NetworkError(timedOut, timedOut ? 'Request timed out' : 'Network unavailable');
  } finally {
    clearTimeout(timer);
  }

  recordVersionHeaders({
    minAppVersion: response.headers.get('X-Min-App-Version'),
    latestAppVersion: response.headers.get('X-Latest-App-Version'),
    killSwitch: response.headers.get('X-Kill-Switch') === '1',
  });

  if (response.status === 401 && auth && !options.isRetryAfterRefresh) {
    // Single-flight refresh, then replay exactly once. A failed refresh
    // freezes sync but never touches locally held evidence.
    await clearAccessToken();
    const refreshed = await refreshSession();
    if (refreshed) {
      return apiRequest<T>(path, { ...options, isRetryAfterRefresh: true });
    }
  }

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? safeJsonParse(text) : null;

  if (!response.ok) {
    const code =
      typeof parsed === 'object' && parsed !== null && 'code' in parsed
        ? String((parsed as { code: unknown }).code)
        : null;
    const message =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : response.statusText;
    throw new ApiError(response.status, code, message, parsed);
  }

  return parsed as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Direct-to-S3 upload. Bytes never transit our API. */
export async function uploadToS3(
  url: string,
  fileUri: string,
  contentType: string,
  byteSize: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const blob = await (await fetch(fileUri)).blob();
    const response = await fetch(url, {
      method: 'PUT',
      // Content-Type and exact length are part of the presigned signature.
      headers: { 'Content-Type': contentType, 'Content-Length': String(byteSize) },
      body: blob,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiError(response.status, null, `S3 upload failed (${response.status})`);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const timedOut = (err as Error).name === 'AbortError';
    throw new NetworkError(timedOut, timedOut ? 'Upload timed out' : 'Upload failed');
  } finally {
    clearTimeout(timer);
  }
}
