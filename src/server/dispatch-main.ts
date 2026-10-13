import { closeDatabase, initDatabase } from './db.js';
import { loadEnv } from './env.js';
import { runDueDispatches } from './dispatch.js';

/**
 * Entrypoint do Cron Job no Railway (ou execução avulsa local).
 *
 * Railway:
 * 1. Serviço web: start `npm start` e ENABLE_INTERNAL_SCHEDULER=0
 * 2. Cron Job: schedule `*/5 * * * *` e start `npm run dispatch`
 *
 * O lock no Postgres evita envio duplicado se o scheduler interno ainda estiver ligado.
 */

loadEnv();

try {
  await initDatabase();
  const result = await runDueDispatches();
  console.log(JSON.stringify(result));
  await closeDatabase();
  process.exit(result.locked === false ? 0 : result.failed ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
}
