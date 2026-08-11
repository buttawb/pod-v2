import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchAttempts, type AttemptRow } from './api';
import { SummaryDialog } from './SummaryDialog';
import { DELIVERED_OUTCOMES, OUTCOME_LABELS } from './outcomes';

const FILTERS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  ...Object.entries(OUTCOME_LABELS).map(([value, label]) => ({ value, label })),
];

/**
 * The full evidence record, paged with the API's keyset cursor rather than
 * an offset: pages stay stable while new attempts arrive, which matters when
 * what you are paging through is evidence.
 */
export function AttemptsPage() {
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<AttemptRow | null>(null);

  const load = useCallback(
    async (nextCursor: string | null, replace: boolean, filter: string | null) => {
      setLoading(true);
      try {
        const page = await fetchAttempts(nextCursor ?? undefined, filter ?? undefined);
        setAttempts((prev) => (replace ? page.attempts : [...prev, ...page.attempts]));
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(null, true, outcome);
  }, [load, outcome]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.label}
            size="sm"
            variant={outcome === f.value ? 'primary' : 'outline'}
            onClick={() => setOutcome(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Stop</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attempts.map((attempt) => (
                <TableRow key={attempt.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {new Date(attempt.received_at).toLocaleString([], {
                      day: '2-digit',
                      month: 'short',
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
                    <Badge variant={DELIVERED_OUTCOMES.has(attempt.outcome) ? 'success' : 'warning'}>
                      {OUTCOME_LABELS[attempt.outcome] ?? attempt.outcome}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={attempt.evidence_status === 'complete' ? 'success' : 'warning'}
                      appearance="outline"
                    >
                      {attempt.evidence_status === 'complete' ? 'Complete' : 'Awaiting media'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {/* v1_compat rows come from the legacy fleet: worth seeing
                        at a glance during the migration window. */}
                    <span className="text-xs text-muted-foreground">{attempt.source}</span>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(attempt)}>
                      {attempt.sent_at ? 'Sent' : attempt.draft_text ? 'Review draft' : 'None'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {attempts.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No attempts match this filter.
            </p>
          ) : null}

          {hasMore ? (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => void load(cursor, false, outcome)}
              >
                {loading ? 'Loading...' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {selected ? (
        <SummaryDialog
          attempt={selected}
          onClose={() => setSelected(null)}
          onChanged={() => void load(null, true, outcome)}
        />
      ) : null}
    </div>
  );
}
