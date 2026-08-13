/**
 * What to tell a driver before signing them out.
 *
 * There was no sign-out at all: `signOut()` existed in the auth module and
 * nothing anywhere called it, so on a shared handset a driver could not hand
 * the phone to the next person.
 *
 * The reason it needs its own module is the warning. Signing out is safe -
 * credentials are cleared and nothing on disk is touched - but a driver with
 * unsent evidence has no way to know that, and "will I lose the photos I took
 * in the basement?" is exactly the question that stops someone tapping a
 * button they should tap. So the copy has to be specific about what is
 * outstanding, and copy that changes with state is worth testing.
 */
export interface SyncOutstanding {
  /** Recorded, not yet sent. */
  onDevice: number;
  /** Mid-flight right now. */
  sending: number;
  /** Attempt is on the server; photographs are still going up. */
  uploading: number;
  /** Parked after repeated failure, waiting for a person. */
  needsAttention: number;
}

export interface SignOutPlan {
  title: string;
  message: string;
  confirmLabel: string;
  /** True when anything at all is still owed to the server. */
  hasUnsentWork: boolean;
}

/** Reads as English rather than as a tuple: "2 attempts and 3 photographs". */
function list(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function planSignOut(counts: SyncOutstanding): SignOutPlan {
  const attempts = counts.onDevice + counts.sending;
  const parts: string[] = [];

  if (attempts > 0) parts.push(plural(attempts, 'attempt', 'attempts'));
  if (counts.uploading > 0) parts.push(plural(counts.uploading, 'photograph', 'photographs'));
  if (counts.needsAttention > 0) parts.push(plural(counts.needsAttention, 'parked attempt', 'parked attempts'));

  if (parts.length === 0) {
    return {
      title: 'Sign out?',
      message: 'Everything you recorded today has reached the server.',
      confirmLabel: 'Sign out',
      hasUnsentWork: false,
    };
  }

  return {
    title: 'Sign out?',
    // Naming the work and then saying it survives, in that order: the driver's
    // worry is answered by the second half of the sentence, so it must not be
    // the part they have to infer.
    message:
      `${list(parts)} still to reach the server. This stays on the phone, ` +
      'attributed to you, and keeps uploading. Signing out never deletes evidence.',
    confirmLabel: 'Sign out anyway',
    hasUnsentWork: true,
  };
}
