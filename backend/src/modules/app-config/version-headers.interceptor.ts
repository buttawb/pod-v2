import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * Version policy rides on EVERY response, so a mid-shift policy change is
 * noticed on the driver's next sync rather than at the next config poll.
 * X-Kill-Switch is per-request: it compares the caller's X-App-Version
 * against the blocklist.
 */
@Injectable()
export class VersionHeadersInterceptor implements NestInterceptor {
  constructor(private readonly config: ConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    response.setHeader('X-Min-App-Version', this.config.get<string>('MIN_APP_VERSION', '1.0.0'));
    response.setHeader(
      'X-Latest-App-Version',
      this.config.get<string>('LATEST_APP_VERSION', '2.0.0'),
    );

    const clientVersion = request.headers['x-app-version'];
    const blocked = (this.config.get<string>('BLOCKED_APP_VERSIONS', '') ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const killed = typeof clientVersion === 'string' && blocked.includes(clientVersion);
    response.setHeader('X-Kill-Switch', killed ? '1' : '0');

    return next.handle();
  }
}
