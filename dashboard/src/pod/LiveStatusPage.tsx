import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  clearSession,
  fetchAttempts,
  fetchStats,
  openFeed,
  type AttemptRow,
  type OfficeSession,
  type TodayStats,
} from './api';
import { SummaryDialog } from './SummaryDialog';

const OUTCOME_LABELS: Record<string, string> = {
  delivered_to_person: 'Delivered to person',
  left_with_neighbour: 'Left with neighbour',
  left_safe_place: 'Left in safe place',
  no_answer_carded: 'No answer / carded',
  refused: 'Refused',
  access_failure: 'Access failure',
};

const DELIVERED = new Set(['delivered_to_person', 'left_with_neighbour', 'left_safe_place']);

export function LiveStatusPage({
  session,
  onSignOut,
}: {
  session: OfficeSession;
  onSignOut: () => void;
}) {
  const [stats, setStats] = useState<TodayStats | null>(null);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [selected, setSelected] = useState<AttemptRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextStats, page] = await Promise.all([fetchStats(), fetchAttempts()]);
      setStats(nextStats);
      setAttempts(page.attempts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // The feed is a doorbell: on an event we refresh from the table, which
    // stays the single source of truth for what the office sees.
    return openFeed(() => {
      setLiveCount((n) => n + 1);
      void load();
    });
  }, [load]);

  const tiles = useMemo(
    () => [
      { label: 'Pending', value: stats?.stops.pending ?? 0, tone: 'secondary' as const },
      { label: 'Delivered', value: stats?.stops.delivered ?? 0, tone: 'success' as const },
      { label: 'Attempted', value: stats?.stops.attempted ?? 0, tone: 'warning' as const },
      { label: 'Failed', value: stats?.stops.failed ?? 0, tone: 'destructive' as const },
      { label: 'Attempts today', value: stats?.attempts.attempts_today ?? 0, tone: 'primary' as const },
      {
        label: 'Awaiting evidence',
        value: stats?.attempts.pending_media ?? 0,
        tone: 'warning' as const,
      },
    ],
    [stats],
  );

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="flex items-center justify-between border-b bg-background px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">Live delivery status</h1>
          <p className="text-sm text-muted-foreground">
            {liveCount > 0 ? `${liveCount} live update${liveCount > 1 ? 's' : ''} received` : 'Connected'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{session.user.displayName}</span>
          <Button
            variant="outline"
            onClick={() => {
              clearSession();
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <main className="flex flex-col gap-6 p-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {tiles.map((tile) => (
            <Card key={tile.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {tile.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-3xl font-semibold">{tile.value}</span>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent attempts</CardTitle>
          </CardHeader>
          <CardContent>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Stop</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead>Customer summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attempts.map((attempt) => (
                  <TableRow key={attempt.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(attempt.received_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{attempt.address}</div>
                      <div className="text-xs text-muted-foreground">{attempt.postcode}</div>
                    </TableCell>
                    <TableCell className="text-sm">{attempt.driver_name}</TableCell>
                    <TableCell>
                      <Badge variant={DELIVERED.has(attempt.outcome) ? 'success' : 'warning'}>
                        {OUTCOME_LABELS[attempt.outcome] ?? attempt.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {/* Incomplete evidence is a first-class, visible state:
                          "attempt made, photos not yet received" must never
                          be mistaken for full proof. */}
                      <Badge
                        variant={attempt.evidence_status === 'complete' ? 'success' : 'warning'}
                        appearance="outline"
                      >
                        {attempt.evidence_status === 'complete' ? 'Complete' : 'Awaiting media'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => setSelected(attempt)}>
                        {attempt.sent_at
                          ? 'Sent'
                          : attempt.draft_text
                            ? 'Review draft'
                            : 'No summary'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>

      {selected ? (
        <SummaryDialog
          attempt={selected}
          onClose={() => setSelected(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
