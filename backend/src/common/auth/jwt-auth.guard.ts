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
