import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { clearSession, type OfficeSession } from './api';

export type Page = 'live' | 'attempts' | 'map' | 'rollout';

const NAV: Array<{ id: Page; label: string; hint: string; icon: ReactNode }> = [
  {
    id: 'live',
    label: 'Live status',
    hint: "Today's totals and the newest attempts",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-5">
        <path d="M3 12h4l3 8 4-16 3 8h4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'attempts',
    label: 'All attempts',
    hint: 'Search the evidence record',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-5">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'map',
    label: 'Depot map',
    hint: "Every stop in today's coverage",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-5">
        <path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3Z" strokeLinejoin="round" />
        <path d="M9 3v15M15 6v15" />
      </svg>
    ),
  },
  {
    id: 'rollout',
    label: 'Rollout',
    hint: 'App version policy in force',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-5">
        <path d="M12 3v12M8 11l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
      </svg>
    ),
  },
];

/**
 * The root element Metronic ships is `display:flex`, so a page that does not
 * claim the space sizes to its content and leaves the viewport half empty.
 * `grow` and `w-full` here are what make the shell fill the window.
 */
export function AppShell({
  session,
  page,
  onNavigate,
  onSignOut,
  liveCount,
  children,
}: {
  session: OfficeSession;
  page: Page;
  onNavigate: (page: Page) => void;
  onSignOut: () => void;
  liveCount: number;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen w-full grow overflow-hidden bg-muted/40">
      <aside className="hidden h-full w-64 shrink-0 flex-col overflow-y-auto border-r bg-background md:flex">
        <div className="flex h-16 items-center gap-2 border-b px-5">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            PD
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Proof of Delivery</div>
            <div className="text-xs text-muted-foreground">Office</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-3">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`flex items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
                page === item.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-muted'
              }`}
            >
              <span className="mt-0.5">{item.icon}</span>
              <span>
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-muted-foreground">{item.hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="border-t p-3">
          <div className="flex items-center gap-2 rounded-md px-2 py-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">
              {session.user.displayName.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-medium">{session.user.displayName}</div>
              <div className="truncate text-xs text-muted-foreground">{session.user.email}</div>
            </div>
          </div>
          <Button
            variant="outline"
            className="mt-2 w-full"
            onClick={() => {
              clearSession();
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b bg-background px-6">
          <div>
            <h1 className="text-lg font-semibold">
              {NAV.find((n) => n.id === page)?.label}
            </h1>
            <p className="text-xs text-muted-foreground">
              {NAV.find((n) => n.id === page)?.hint}
              {page === 'live' && liveCount > 0 ? ` - ${liveCount} live update${liveCount > 1 ? 's' : ''}` : ''}
            </p>
          </div>

          {/* Mobile navigation: the sidebar is hidden below md. */}
          <div className="flex gap-2 md:hidden">
            {NAV.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={page === item.id ? 'primary' : 'outline'}
                onClick={() => onNavigate(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>

          <span className="hidden items-center gap-2 text-sm text-muted-foreground md:flex">
            <span className="size-2 animate-pulse rounded-full bg-green-500" />
            Live
          </span>
        </header>

        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
