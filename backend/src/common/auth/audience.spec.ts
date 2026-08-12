import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard, AUDIENCE_KEY, ROLES_KEY, IS_PUBLIC_KEY } from './jwt-auth.guard';
import { Audience } from './jwt-payload';

/**
 * The v1 fleet cannot be updated, so v2's auth has to be free to change
 * without reaching it. These pin that separation: a token minted for one
 * surface must not be accepted by the other. Without this the coupling comes
 * back the first time someone adds a controller and forgets the decorator.
 */
describe('token audience separates the v1 and v2 surfaces', () => {
  const context = (token: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: 'Bearer stub' }, query: {} }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as unknown as ExecutionContext;

  const guardFor = (routeAudience: Audience | undefined, token: Record<string, unknown>) => {
    const reflector = {
      getAllAndOverride: (key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === AUDIENCE_KEY) return routeAudience;
        if (key === ROLES_KEY) return ['driver'];
        return undefined;
      },
    } as unknown as Reflector;

    const jwt = { verifyAsync: () => Promise.resolve(token) } as never;
    return new JwtAuthGuard(jwt, reflector);
  };

  const v2Token = { sub: 'd1', role: 'driver', aud: Audience.V2 };
  const v1Token = { sub: 'd1', role: 'driver', aud: Audience.Legacy };
  const unstamped = { sub: 'd1', role: 'driver' };

  it('accepts a v2 token on a v2 route', async () => {
    await expect(guardFor(undefined, v2Token).canActivate(context(v2Token))).resolves.toBe(true);
  });

  it('accepts a v1 token on the legacy route', async () => {
    await expect(
      guardFor(Audience.Legacy, v1Token).canActivate(context(v1Token)),
    ).resolves.toBe(true);
  });

  it('rejects a v1 token on a v2 route', async () => {
    await expect(guardFor(undefined, v1Token).canActivate(context(v1Token))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a v2 token on the legacy route', async () => {
    await expect(
      guardFor(Audience.Legacy, v2Token).canActivate(context(v2Token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // Tokens minted before the claim existed keep working on v2 so a deploy does
  // not log the fleet out. They must never be good enough for the v1 surface,
  // which has only ever issued stamped tokens.
  it('treats an unstamped token as v2, and never as legacy', async () => {
    await expect(guardFor(undefined, unstamped).canActivate(context(unstamped))).resolves.toBe(
      true,
    );
    await expect(
      guardFor(Audience.Legacy, unstamped).canActivate(context(unstamped)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
