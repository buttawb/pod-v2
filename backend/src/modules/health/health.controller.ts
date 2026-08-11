import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../../common/auth/jwt-auth.guard';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** Liveness + which LB instance answered (visible proof of round-robin). */
  @Public()
  @Get()
  health() {
    return {
      status: 'ok',
      instance: this.config.get<string>('INSTANCE_ID', 'backend-local'),
      time: new Date().toISOString(),
    };
  }

  @Public()
  @Get('ready')
  async ready() {
    await this.dataSource.query('SELECT 1');
    return { status: 'ready' };
  }
}
