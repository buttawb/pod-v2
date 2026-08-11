import { Card, CardContent, CardHeader } from '@/components/ui/card';

/**
 * Skeletons rather than a spinner: the office opens this on a shared screen
 * and needs to see the shape of the page arriving, not a blank rectangle.
 * Each variant mirrors the real layout so nothing jumps when data lands.
 */
function Bar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export function TilesSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Bar className="h-4 w-24" />
          </CardHeader>
          <CardContent>
            <Bar className="h-8 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-4 border-b pb-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Bar key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 py-2">
          {Array.from({ length: cols }).map((_, c) => (
            <Bar key={c} className={`h-4 flex-1 ${c === 1 ? 'h-8' : ''}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function BlockSkeleton({ className = 'h-96' }: { className?: string }) {
  return <Bar className={`w-full ${className}`} />;
}
