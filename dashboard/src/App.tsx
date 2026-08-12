import { useEffect, useState } from 'react';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { LoginPage } from '@/pod/LoginPage';
import { LiveStatusPage } from '@/pod/LiveStatusPage';
import { AttemptsPage } from '@/pod/AttemptsPage';
import { DepotMapPage } from '@/pod/DepotMapPage';
import { RolloutPage } from '@/pod/RolloutPage';
import { AppShell, type Page } from '@/pod/AppShell';
import { toast } from 'sonner';
import { getStoredSession, onSessionExpired, type OfficeSession } from '@/pod/api';

export function App() {
  const [session, setSession] = useState<OfficeSession | null>(null);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<Page>('live');
  const [liveCount, setLiveCount] = useState(0);

  useEffect(() => {
    setSession(getStoredSession());
    setReady(true);
    // The session can end while the app is open, and until this existed the
    // shell kept the stale session in state and carried on rendering pages
    // whose requests all failed, which looked like an empty day rather than
    // a sign-out.
    return onSessionExpired(() => {
      setSession(null);
      toast.error('Your session expired. Please sign in again.');
    });
  }, []);

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      storageKey="pod-theme"
      enableSystem
      disableTransitionOnChange
      enableColorScheme
    >
      <Toaster />
      {!ready ? null : session ? (
        <AppShell
          session={session}
          page={page}
          onNavigate={setPage}
          onSignOut={() => setSession(null)}
          liveCount={liveCount}
        >
          {page === 'live' ? (
            <LiveStatusPage onLiveEvent={setLiveCount} />
          ) : page === 'attempts' ? (
            <AttemptsPage />
          ) : page === 'map' ? (
            <DepotMapPage />
          ) : (
            <RolloutPage />
          )}
        </AppShell>
      ) : (
        <LoginPage onSignedIn={setSession} />
      )}
    </ThemeProvider>
  );
}
