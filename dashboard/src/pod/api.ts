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

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = getStoredSession();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${session?.accessToken ?? ''}`,
    },
  });

  if (response.status === 401 && session?.refreshToken) {
    const refreshed = await fetch(`${API_BASE}/api/v2/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (refreshed.ok) {
      const tokens = (await refreshed.json()) as { accessToken: string; refreshToken: string };
      storeSession({ ...session, ...tokens });
      return authedFetch(path, init);
    }
    clearSession();
  }
  return response;
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
  const session = getStoredSession();
  const source = new EventSource(
    `${API_BASE}/api/v2/office/feed?access_token=${encodeURIComponent(session?.accessToken ?? '')}`,
  );

  source.addEventListener('attempt', (event) => {
    try {
      onEvent(JSON.parse((event as MessageEvent<string>).data) as AttemptEvent);
    } catch {
      // A malformed frame is not worth tearing the feed down for.
    }
  });

  return () => source.close();
}
