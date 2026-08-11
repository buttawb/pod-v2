import { AppDataSource } from './data-source';

/**
 * Programmatic migration runner for deploys:
 *   node dist/database/migrate.js
 * Run with the OWNER database URL; the API runtime connects as pod_app,
 * which cannot (and must not) alter schema.
 */
async function main(): Promise<void> {
  await AppDataSource.initialize();
  const applied = await AppDataSource.runMigrations({ transaction: 'none' });
  for (const m of applied) console.log(`applied: ${m.name}`);
  if (applied.length === 0) console.log('no pending migrations');
  await AppDataSource.destroy();
}

void main();
