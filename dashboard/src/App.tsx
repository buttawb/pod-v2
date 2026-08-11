import { useEffect, useState } from 'react';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { LoginPage } from '@/pod/LoginPage';
import { LiveStatusPage } from '@/pod/LiveStatusPage';
import { getStoredSession, type OfficeSession } from '@/pod/api';

export function App() {
  const [session, setSession] = useState<OfficeSession | null>(null);
  const [ready, setReady] = useState(false);

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
        <LiveStatusPage session={session} onSignOut={() => setSession(null)} />
      ) : (
        <LoginPage onSignedIn={setSession} />
      )}
    </ThemeProvider>
  );
}
