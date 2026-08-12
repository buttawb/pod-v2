import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * Wires the Android back gesture and hardware button to a screen's own idea of
 * "back".
 *
 * Navigation here is a small union in App.tsx rather than a navigator, so
 * nothing was listening: every back press fell through to the OS default,
 * which finishes the activity. Pressing back one screen into the app closed it
 * outright, and any capture in progress went with it.
 *
 * Handlers registered later run first, so a nested screen (the map surfaces
 * inside Maps) takes precedence over the root while it is mounted. Return true
 * to say "handled"; return false to let the press fall through and, at the top
 * of the stack, leave the app.
 */
export function useAndroidBack(handler: () => boolean): void {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => subscription.remove();
  }, [handler]);
}
