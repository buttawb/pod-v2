import { useEffect, useState } from 'react';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { LoginPage } from '@/pod/LoginPage';
import { LiveStatusPage } from '@/pod/LiveStatusPage';
import { AttemptsPage } from '@/pod/AttemptsPage';
import { AppShell, type Page } from '@/pod/AppShell';
import { getStoredSession, type OfficeSession } from '@/pod/api';

export function App() {
  const [session, setSession] = useState<OfficeSession | null>(null);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<Page>('live');
  const [liveCount, setLiveCount] = useState(0);

  useEffect(() => {
    setSession(getStoredSession());
    setReady(true);
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
          {page === 'live' ? <LiveStatusPage onLiveEvent={setLiveCount} /> : <AttemptsPage />}
        </AppShell>
      ) : (
        <LoginPage onSignedIn={setSession} />
      )}
    </ThemeProvider>
  );
}
