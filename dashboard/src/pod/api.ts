/**
 * Same-origin by default: the dashboard is served by Caddy from the host
 * that also proxies /api, so there is no CORS surface and no API URL to
 * misconfigure between environments.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

const SESSION_KEY = 'pod.office.session';

export interface OfficeSession {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string; email: string };
}

export function getStoredSession(): OfficeSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OfficeSession;
  } catch {
    return null;
  }
}

export function storeSession(session: OfficeSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export async function officeLogin(email: string, password: string): Promise<OfficeSession> {
  const response = await fetch(`${API_BASE}/api/v2/auth/office/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Wrong email or password' : 'Sign in failed');
  }
  const session = (await response.json()) as OfficeSession;
  storeSession(session);
  return session;
}

const expiryListeners = new Set<() => void>();

/**
 * Fires when the session is definitively over, so the shell can return to the
 * login screen. Without it the app kept the session in React state after the
 * tokens were gone and carried on rendering empty pages, which reads as "no
 * deliveries today" rather than "you are signed out".
 */
export function onSessionExpired(listener: () => void): () => void {
  expiryListeners.add(listener);
  return () => {
    expiryListeners.delete(listener);
  };
}

function endSession(): void {
  clearSession();
  for (const listener of expiryListeners) listener();
}

/**
 * One refresh at a time, shared by every caller.
 *
 * Refresh tokens rotate, so a refresh is a single-use claim. When several
 * requests expire together (this dashboard loads stats, attempts and the feed
 * at once) each used to start its own: one won, and the rest got back 409
 * "Refresh in progress, retry" from the server's rotation arbiter. The losers
 * treated that as failure and cleared the session, wiping the winner's
 * freshly stored tokens. That is how a healthy session ended up signed out,
 * showing three 401s and a page of zeros.
 */
let inFlightRefresh: Promise<OfficeSession | null> | null = null;

const REFRESH_CONFLICT_ATTEMPTS = 3;
const REFRESH_RETRY_MS = 150;

async function refreshSession(): Promise<OfficeSession | null> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    try {
      for (let attempt = 0; attempt < REFRESH_CONFLICT_ATTEMPTS; attempt += 1) {
        // Re-read each pass: a concurrent winner may already have stored one.
        const session = getStoredSession();
        if (!session?.refreshToken) return null;

        const response = await fetch(`${API_BASE}/api/v2/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });

        if (response.ok) {
          const tokens = (await response.json()) as {
            accessToken: string;
            refreshToken: string;
          };
          const next = { ...session, ...tokens };
          storeSession(next);
          return next;
        }

        // 409 is the server asking us to retry, not rejecting us: a rotation
        // is in flight and its successor is not linked yet.
        if (response.status === 409) {
          await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_MS * (attempt + 1)));
          continue;
        }

        // 401 means revoked, or reuse detected and the family contained. That
        // is the only answer that actually ends the session.
        if (response.status === 401) {
          endSession();
          return null;
        }

        // Anything else (5xx, offline) is transient. Keep the tokens; they may
        // work again once the backend is reachable.
        return null;
      }
      return null;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

async function authedFetch(
  path: string,
  init: RequestInit = {},
  retryAfterRefresh = true,
): Promise<Response> {
  const session = getStoredSession();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${session?.accessToken ?? ''}`,
    },
  });

  if (response.status !== 401 || !retryAfterRefresh) return response;

  const refreshed = await refreshSession();
  if (!refreshed) return response;

  // Exactly one retry: if the brand-new token is also rejected, something is
  // wrong that another round trip will not fix.
  return authedFetch(path, init, false);
}

export interface TodayStats {
  stops: { pending: number; attempted: number; delivered: number; failed: number; total: number };
  attempts: { attempts_today: number; pending_media: number };
}

export async function fetchStats(): Promise<TodayStats> {
  const response = await authedFetch('/api/v2/office/stats');
  if (!response.ok) throw new Error('Could not load stats');
  return (await response.json()) as TodayStats;
}

export interface AttemptRow {
  id: string;
  stop_id: string;
  outcome: string;
  evidence_status: string;
  note: string | null;
  captured_at: string;
  received_at: string;
  source: string;
  app_version: string;
  address: string;
  postcode: string;
  sequence: number;
  driver_name: string;
  ai_status: string | null;
  draft_text: string | null;
  final_text: string | null;
  ai_source: string | null;
  sent_at: string | null;
}

export async function fetchAttempts(
  cursor?: string,
  outcome?: string,
): Promise<{ attempts: AttemptRow[]; nextCursor: string | null; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (outcome) params.set('status', outcome);
  const query = params.toString() ? `?${params.toString()}` : '';
  const response = await authedFetch(`/api/v2/office/attempts${query}`);
  if (!response.ok) throw new Error('Could not load attempts');
  return (await response.json()) as {
    attempts: AttemptRow[];
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface SummaryPayload {
  attemptId: string;
  status: string;
  draft: string | null;
  source: string | null;
  model: string | null;
  finalText: string | null;
  sentAt: string | null;
}

export async function editSummary(attemptId: string, finalText: string): Promise<SummaryPayload> {
  const response = await authedFetch(`/api/v2/office/attempts/${attemptId}/summary`, {
    method: 'PATCH',
    body: JSON.stringify({ finalText }),
  });
  if (!response.ok) throw new Error('Could not save the summary');
  return (await response.json()) as SummaryPayload;
}

export async function sendSummary(attemptId: string): Promise<SummaryPayload> {
  const response = await authedFetch(`/api/v2/office/attempts/${attemptId}/summary/send`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Could not send the summary');
  return (await response.json()) as SummaryPayload;
}

export async function regenerateSummary(attemptId: string): Promise<SummaryPayload> {
  const response = await authedFetch(`/api/v2/office/attempts/${attemptId}/summary/regenerate`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Could not regenerate the summary');
  return (await response.json()) as SummaryPayload;
}

export interface AttemptEvent {
  attemptId: string;
  stopId: string;
  driverId: string;
  outcome: string;
  evidenceStatus: string;
  receivedAt: string;
}

/**
 * EventSource cannot carry an Authorization header, so the token rides as a
 * query parameter on this endpoint only. It is short-lived (15 minutes) and
 * the connection is HTTPS end to end; the alternative (a cookie) would add
 * a CSRF surface to a read-only feed.
 *
 * Reconnects are automatic and carry Last-Event-ID, so the server replays
 * from the table and no event is lost in the gap.
 */
export function openFeed(onEvent: (event: AttemptEvent) => void): () => void {
  let source: EventSource | null = null;
  let lastEventId: string | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const session = getStoredSession();

    // The token is in the URL, so a rotation cannot be applied to a live
    // connection: EventSource would keep reconnecting with the expired one
    // forever. We reconnect ourselves instead, which means we also have to
    // carry the cursor by hand, since only EventSource's own reconnects set
    // the Last-Event-ID header.
    const params = new URLSearchParams({ access_token: session?.accessToken ?? '' });
    if (lastEventId) params.set('last_event_id', lastEventId);

    source = new EventSource(`${API_BASE}/api/v2/office/feed?${params.toString()}`);

    source.addEventListener('attempt', (event) => {
      const message = event as MessageEvent<string>;
      if (message.lastEventId) lastEventId = message.lastEventId;
      try {
        onEvent(JSON.parse(message.data) as AttemptEvent);
      } catch {
        // A malformed frame is not worth tearing the feed down for.
      }
    });

    source.addEventListener('error', () => {
      if (closed) return;
      source?.close();
      // Most likely the access token just expired. Refreshing is shared with
      // every other caller, so this costs nothing when one is already running.
      void refreshSession().then(() => {
        if (closed) return;
        retry = setTimeout(connect, 1000);
      });
    });
  };

  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    source?.close();
  };
}

export interface VersionPolicy {
  minAppVersion: string;
  latestAppVersion: string;
  blockedVersions: string[];
  updateUrl: string | null;
  policy: { graceHours: number; blockNewCapturesInGrace: boolean; uploadAlwaysAllowed: boolean };
}

export async function fetchConfig(): Promise<VersionPolicy> {
  const response = await fetch(`${API_BASE}/api/config`);
  if (!response.ok) throw new Error('Could not load the version policy');
  return (await response.json()) as VersionPolicy;
}

export interface DepotFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { id: string; s: number; q: number };
  }>;
}

export async function fetchDepotGeoJson(): Promise<DepotFeatureCollection> {
  const response = await authedFetch('/api/v2/depot/stops.geojson');
  if (!response.ok) throw new Error('Could not load the depot map');
  return (await response.json()) as DepotFeatureCollection;
}
