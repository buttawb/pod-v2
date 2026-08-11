import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities';

/**
 * migrationsTransactionMode is 'none' because migration 0003 uses
 * CREATE INDEX CONCURRENTLY, which cannot run inside a transaction block.
 * Every migration is therefore written idempotently (IF NOT EXISTS / OR
 * REPLACE) so a partial failure recovers by simply re-running.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ALL_ENTITIES,
  migrations: [`${__dirname}/migrations/*{.ts,.js}`],
  migrationsTransactionMode: 'none',
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});
