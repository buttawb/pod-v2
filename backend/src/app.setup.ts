import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { json, urlencoded } from 'express';

/** Shared between main.ts and e2e tests so tests exercise the real pipeline. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.set('trust proxy', 1); // behind Caddy

  app.use(helmet());
  // Photos never transit this API (presigned S3 direct), so requests are tiny.
  app.use(json({ limit: '256kb' }));
  app.use(urlencoded({ extended: true, limit: '256kb' }));

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI }); // /api/v2/...; legacy routes are VERSION_NEUTRAL at /api/...

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:5173'],
    credentials: false,
  });
}
