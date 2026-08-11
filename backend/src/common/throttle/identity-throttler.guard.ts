import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import type { JwtPayload } from '../auth/jwt-payload';

/**
 * Rate limiting is tracked by authenticated identity, falling back to IP
 * only for routes that have no identity yet (login, refresh, config).
 *
 * Tracking by IP alone is wrong for this product: mobile carriers put very
 * large numbers of subscribers behind a handful of NAT addresses, so a
 * per-IP budget would let one busy depot exhaust the allowance of every
 * unrelated driver on the same carrier gateway. Identity is also the thing
 * we actually want to bound - one driver's device cannot be shielded by
 * changing networks mid-shift.
 */
@Injectable()
export class IdentityThrottlerGuard extends ThrottlerGuard {
  protected getTracker(
    req: Request & { user?: JwtPayload; body?: { employeeRef?: string; email?: string } },
  ): Promise<string> {
    if (req.user?.sub) {
      // Per device where we know it: two handsets signed in as the same
      // driver get their own budgets, which is the honest unit of traffic.
      return Promise.resolve(`user:${req.user.sub}:${req.user.deviceId ?? 'nodevice'}`);
    }

    // Sign-in has no identity yet, so it is bounded by the ACCOUNT being
    // attempted. Password guessing targets one account, which this stops
    // dead; keying on IP instead would throttle a depot where fifty drivers
    // sign in from the same site connection at shift start, and would let
    // an attacker rotate addresses to evade the limit anyway.
    const account = req.body?.employeeRef ?? req.body?.email;
    if (typeof account === 'string' && account.length > 0) {
      return Promise.resolve(`account:${account.toLowerCase()}`);
    }

    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ??
      req.ip ??
      'unknown';
    return Promise.resolve(`ip:${ip}`);
  }
}
