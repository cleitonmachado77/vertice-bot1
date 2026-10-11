import { closeDatabase, initDatabase } from './db.js';
import { loadEnv } from './env.js';
import { runDueDispatches } from './dispatch.js';

// Execução avulsa. O painel no Railway já chama o mesmo disparo a cada 5 minutos.
// Não crie outro cron com este comando: a mensagem sairia duas vezes.

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
