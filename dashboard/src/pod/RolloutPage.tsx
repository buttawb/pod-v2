import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchConfig, type VersionPolicy } from './api';
import { BlockSkeleton } from './Skeleton';

/**
 * The version policy actually in force, read from the same endpoint the
 * handsets poll. Read-only on purpose: changing what 3,000 drivers are
 * allowed to run is a deploy-time decision with a rollback path, not a
 * button on a dashboard.
 */
export function RolloutPage() {
  const [policy, setPolicy] = useState<VersionPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchConfig()
      .then(setPolicy)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!policy) return <BlockSkeleton className="h-64" />;

  const rows: Array<[string, string, string]> = [
    [
      'Minimum version',
      policy.minAppVersion,
      'Below this a driver is asked to update. Mid-route they get grace first.',
    ],
    ['Latest version', policy.latestAppVersion, 'Offered as a dismissible nudge.'],
    [
      'Blocked versions',
      policy.blockedVersions.length ? policy.blockedVersions.join(', ') : 'None',
      'Kill switch: blocks immediately, ignoring grace.',
    ],
    [
      'Grace window',
      `${policy.policy.graceHours} hours`,
      'A driver mid-route is never hard-blocked before their route ends.',
    ],
    [
      'Uploads during a block',
      policy.policy.uploadAlwaysAllowed ? 'Always allowed' : 'Blocked',
      'Captured evidence must never be stranded on a handset.',
    ],
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Version policy in force</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {rows.map(([label, value, hint]) => (
            <div key={label} className="flex flex-col gap-1 border-b pb-3 last:border-0 last:pb-0">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium">{label}</span>
                <Badge variant={label === 'Blocked versions' && value !== 'None' ? 'destructive' : 'secondary'}>
                  {value}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How a release reaches 3,000 drivers</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-3 text-sm">
            {[
              ['Ring 0', 'Internal and a handful of friendly drivers, 2 days'],
              ['Ring 1', 'One mid-size depot, around 150 drivers, 3 days'],
              ['Ring 2', 'A quarter of depots, 4 days'],
              ['Ring 3', 'The remainder'],
            ].map(([ring, detail]) => (
              <li key={ring} className="flex gap-3">
                <span className="w-16 shrink-0 font-medium">{ring}</span>
                <span className="text-muted-foreground">{detail}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">
            Each ring is gated on crash-free rate, submission failure rate and photo upload
            success. Rollback lowers the minimum version and republishes the previous build.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
