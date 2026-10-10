import { closeDatabase, initDatabase } from './db.js';
import { loadEnv } from './env.js';
import { runDueDispatches } from './dispatch.js';

// Serviço de disparo do Railway: start command `npm run dispatch`
// e Cron Schedule `*/5 * * * *` (UTC). Envia quem já chegou no horário e encerra.

loadEnv();

try {
  await initDatabase();
  const result = await runDueDispatches();
  console.log(JSON.stringify(result));
  await closeDatabase();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
}
