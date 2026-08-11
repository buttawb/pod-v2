import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { Client } from 'pg';
import { ATTEMPT_EVENTS_CHANNEL, type AttemptEventPayload } from '../events/notify';

/**
 * Each backend instance holds ONE dedicated raw pg connection running
 * LISTEN (session state - deliberately outside the TypeORM pool and any
 * transaction pooler) and fans notifications out in-process to its SSE
 * clients. Every instance listens to the same Postgres channel, so it is
 * irrelevant which instance a browser's SSE connection landed on - this is
 * the multi-LB-instance correctness mechanism, with zero extra infra.
 *
 * NOTIFY is at-most-once and that is fine: it is only a doorbell. The table
 * is the source of truth; reconnecting clients catch up via Last-Event-ID.
 */
@Injectable()
export class EventsBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsBusService.name);
  private readonly emitter = new EventEmitter();
  private client: Client | null = null;
  private stopped = false;

  constructor(private readonly config: ConfigService) {
    this.emitter.setMaxListeners(500); // one listener per open SSE connection
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.client?.end().catch(() => undefined);
  }

  subscribe(handler: (event: AttemptEventPayload) => void): () => void {
    this.emitter.on('attempt', handler);
    return () => this.emitter.off('attempt', handler);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.client = new Client({ connectionString: this.config.getOrThrow<string>('DATABASE_URL') });

    this.client.on('notification', (msg) => {
      if (msg.channel !== ATTEMPT_EVENTS_CHANNEL || !msg.payload) return;
      try {
        this.emitter.emit('attempt', JSON.parse(msg.payload) as AttemptEventPayload);
      } catch {
        this.logger.warn('Dropped malformed attempt event payload');
      }
    });

    this.client.on('error', (err) => {
      this.logger.error(`LISTEN connection lost: ${err.message} - reconnecting in 2s`);
      this.client?.end().catch(() => undefined);
      if (!this.stopped) setTimeout(() => void this.connect(), 2000);
    });

    try {
      await this.client.connect();
      await this.client.query(`LISTEN ${ATTEMPT_EVENTS_CHANNEL}`);
      this.logger.log('LISTEN attempt_events established');
    } catch (err) {
      this.logger.error(`LISTEN connect failed: ${(err as Error).message} - retrying in 2s`);
      if (!this.stopped) setTimeout(() => void this.connect(), 2000);
    }
  }
}
