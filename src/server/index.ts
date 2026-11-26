import { closeDatabase, getSetting, initDatabase } from './db.js';
import { loadEnv, env } from './env.js';
import { listen } from './http.js';
import { registerContactRoutes } from './contact-routes.js';
import { registerQuestionnaireRoutes } from './questionnaire-routes.js';
import { registerHookRoutes } from './hooks.js';
import { registerPanelRoutes } from './panel.js';
import { registerFormsRoutes } from './forms-routes.js';
import { registerAgroRoutes } from './agro-routes.js';
import { registerHubDashboardRoutes } from './hub-dashboard.js';
import { registerRoteiroRoutes } from './roteiro-routes.js';
import { startLiveSync } from './live-sync.js';
import { startMessageWorker } from './message-worker.js';
import { startOdooPullScheduler } from './odoo-scheduler.js';
import { startScheduler } from './scheduler.js';
import { applyFormsReminderSchedule } from './forms-reminder.js';

loadEnv();
await initDatabase();
await applyFormsReminderSchedule();
const webhookSecret = getSetting('nevoa_webhook_secret') || env('NEVOA_WEBHOOK_SECRET');
if (!webhookSecret && env('NODE_ENV') === 'production') {
  throw new Error('NEVOA_WEBHOOK_SECRET é obrigatório em produção');
}
if (!webhookSecret) console.warn('webhook: NEVOA_WEBHOOK_SECRET ausente; entradas serão rejeitadas');
registerPanelRoutes();
registerContactRoutes();
registerQuestionnaireRoutes();
registerFormsRoutes();
registerAgroRoutes();
registerHubDashboardRoutes();
registerRoteiroRoutes();
registerHookRoutes();

const port = Number(env('PORT', '8787'));
listen(port);
await startMessageWorker();
startLiveSync();
startScheduler();
startOdooPullScheduler();
console.log(`Vértice Elo em http://localhost:${port}`);
closePoolOnStop();

function closePoolOnStop(): void {
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const force = setTimeout(() => process.exit(0), 1000);
    force.unref();
    void closeDatabase().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
