import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { IdentityThrottlerGuard } from './common/throttle/identity-throttler.guard';
import { ALL_ENTITIES } from './database/entities';
import { envValidationSchema } from './config/env.validation';
import { AiModule } from './modules/ai/ai.module';
import { AppConfigController } from './modules/app-config/app-config.controller';
import { VersionHeadersInterceptor } from './modules/app-config/version-headers.interceptor';
import { AttemptsModule } from './modules/attempts/attempts.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './modules/health/health.controller';
import { LegacyModule } from './modules/legacy/legacy.module';
import { PrivacyController } from './modules/legal/privacy.controller';
import { MediaModule } from './modules/media/media.module';
import { OfficeModule } from './modules/office/office.module';
import { StopsModule } from './modules/stops/stops.module';
import { SyncModule } from './modules/sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities: ALL_ENTITIES,
        synchronize: false, // migrations are the only schema authority
        poolSize: 10,
      }),
    }),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([{ limit: 300, ttl: 60_000 }]),
    AuthModule,
    StopsModule,
    AttemptsModule,
    LegacyModule,
    MediaModule,
    SyncModule,
    OfficeModule,
    AiModule,
  ],
  controllers: [AppConfigController, HealthController, PrivacyController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: IdentityThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: VersionHeadersInterceptor },
  ],
})
export class AppModule {}
