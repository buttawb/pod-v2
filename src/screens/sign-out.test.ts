import { planSignOut, type SyncOutstanding } from './sign-out';

const nothing: SyncOutstanding = { onDevice: 0, sending: 0, uploading: 0, needsAttention: 0 };

describe('warning a driver before they sign out', () => {
  it('says so plainly when nothing is outstanding', () => {
    const plan = planSignOut(nothing);

    expect(plan.hasUnsentWork).toBe(false);
    expect(plan.confirmLabel).toBe('Sign out');
    expect(plan.message).toContain('reached the server');
  });

  it('counts an attempt that is mid-flight as still outstanding', () => {
    // `sending` means the request is in the air and its response may never
    // arrive. Treating it as done would tell a driver their evidence is safe
    // at exactly the moment it might not be.
    const plan = planSignOut({ ...nothing, sending: 1 });

    expect(plan.hasUnsentWork).toBe(true);
    expect(plan.message).toContain('1 attempt');
  });

  it('adds queued and in-flight attempts together rather than listing both', () => {
    // The distinction matters to the sync engine and means nothing to a driver
    // standing in a stairwell.
    expect(planSignOut({ ...nothing, onDevice: 2, sending: 1 }).message).toContain('3 attempts');
  });

  it('counts photographs separately, because they trail their attempt', () => {
    // Two-phase sync: the attempt can be on the server while its photographs
    // are still going up, and that is not "nothing outstanding".
    const plan = planSignOut({ ...nothing, uploading: 3 });

    expect(plan.hasUnsentWork).toBe(true);
    expect(plan.message).toContain('3 photographs');
    expect(plan.message).not.toContain('attempt');
  });

  it('mentions parked work, which is the case a driver most needs to know about', () => {
    const plan = planSignOut({ ...nothing, needsAttention: 1 });

    expect(plan.hasUnsentWork).toBe(true);
    expect(plan.message).toContain('1 parked attempt');
  });

  it('reads as a sentence when several things are outstanding at once', () => {
    const plan = planSignOut({ onDevice: 1, sending: 1, uploading: 4, needsAttention: 2 });

    expect(plan.message).toContain('2 attempts, 4 photographs and 2 parked attempts');
  });

  it('always promises that evidence survives, whenever there is any', () => {
    // This is the whole reason the dialog exists. A driver who believes
    // signing out discards their morning will not sign out, and will hand over
    // an unlocked phone instead.
    for (const counts of [
      { ...nothing, onDevice: 1 },
      { ...nothing, uploading: 1 },
      { ...nothing, needsAttention: 1 },
    ]) {
      const plan = planSignOut(counts);
      expect(plan.message).toMatch(/stays on the phone/);
      expect(plan.message).toMatch(/never deletes evidence/);
    }
  });

  it('singularises, so the dialog never says "1 attempts"', () => {
    expect(planSignOut({ ...nothing, onDevice: 1 }).message).toContain('1 attempt ');
    expect(planSignOut({ ...nothing, uploading: 1 }).message).toContain('1 photograph ');
  });
});
