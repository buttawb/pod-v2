import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Audience } from './jwt-payload';
import type { JwtPayload, Role } from './jwt-payload';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Opt-in for SSE endpoints only. EventSource cannot send an Authorization
 * header, so those routes also accept the short-lived access token as a
 * query parameter. Restricted to read-only feeds and never applied to a
 * route that writes, so a token leaking via a proxy log cannot mutate
 * anything before it expires.
 */
export const ALLOW_QUERY_TOKEN_KEY = 'allowQueryToken';
export const AllowQueryToken = () => SetMetadata(ALLOW_QUERY_TOKEN_KEY, true);

/**
 * Which surface a route belongs to. Routes are v2 unless they say otherwise,
 * so the frozen v1 controllers are the only place that has to opt out, and a
 * new v2 route cannot accidentally inherit the legacy contract.
 */
export const AUDIENCE_KEY = 'audience';
export const RequireAudience = (audience: Audience) => SetMetadata(AUDIENCE_KEY, audience);

/** Global guard: everything requires a valid access token unless @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const header = request.headers.authorization;
    let token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      const allowQueryToken = this.reflector.getAllAndOverride<boolean>(ALLOW_QUERY_TOKEN_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      const queryToken = request.query?.access_token;
      if (allowQueryToken && typeof queryToken === 'string') token = queryToken;
    }
    if (!token) throw new UnauthorizedException('Missing access token');

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    const expected =
      this.reflector.getAllAndOverride<Audience | undefined>(AUDIENCE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? Audience.V2;

    // A token with no audience predates the claim, so it can only be a v2 one:
    // the legacy surface has never issued a token without it. Treating it as v2
    // keeps sessions alive across this deploy without letting a v1 token reach
    // a v2 route. The fallback can go once the fleet has rotated.
    const actual = request.user.aud ?? Audience.V2;
    if (actual !== expected) {
      throw new UnauthorizedException('Token was not issued for this API version');
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && !roles.includes(request.user.role)) {
      throw new UnauthorizedException('Insufficient role');
    }
    return true;
  }
}
