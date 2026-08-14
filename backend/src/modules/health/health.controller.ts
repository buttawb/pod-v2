import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../../common/auth/jwt-auth.guard';

@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** Liveness + which LB instance answered (visible proof of round-robin). */
  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness, and which instance answered (no auth required)',
    description: [
      'Start here. This is the one call you can execute before signing in: press *Try it out*',
      'then *Execute*. No token, no body, no parameters.',
      '',
      'It answers three questions at once: the process is up, the deployment is reachable',
      'through the proxy, and `instance` names the backend container that served this request.',
      'Two instances sit behind the load balancer, so repeating the call and watching',
      '`instance` alternate is the visible proof that round-robin is actually working.',
      '',
      '`time` is the server clock in UTC. The handset compares it against its own to decide',
      'whether it can trust its local timestamps on captured evidence.',
      '',
      'This endpoint deliberately touches nothing else. It stays up while the database is',
      'down, which is what makes it useful as a liveness probe: use /api/health/ready when you',
      'want to know whether the instance can actually serve traffic.',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description:
      'The process is alive. Always 200 if the request reached a running instance.',
    schema: {
      example: {
        status: 'ok',
        instance: 'backend-1',
        time: '2026-08-14T09:41:55.902Z',
      },
    },
  })
  health() {
    return {
      status: 'ok',
      instance: this.config.get<string>('INSTANCE_ID', 'backend-local'),
      time: new Date().toISOString(),
    };
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary:
      'Readiness: the instance can reach its database (no auth required)',
    description: [
      'Press *Try it out* then *Execute*. Like /api/health this needs no token, no body and no',
      'parameters, so it can be run before signing in.',
      '',
      'Readiness is a stronger claim than liveness: this one runs `SELECT 1` against Postgres',
      'through the same connection pool the rest of the API uses. A 200 means this instance',
      'can serve real traffic, which is why the load balancer uses this route rather than',
      '/api/health to decide whether to send requests here.',
      '',
      'If you get a 200 here but a later call fails, the problem is not connectivity or',
      'configuration: look at the specific endpoint.',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description:
      'The database answered, so this instance is ready to take traffic.',
    schema: { example: { status: 'ready' } },
  })
  @ApiResponse({
    status: 500,
    description:
      'The database query failed or timed out. The process is still running, which is why /api/health can be 200 while this is not, and the load balancer should stop routing here until it recovers.',
  })
  async ready() {
    await this.dataSource.query('SELECT 1');
    return { status: 'ready' };
  }
}
