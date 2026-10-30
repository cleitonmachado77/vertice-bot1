import { getSetting, initDatabase } from './db.js';
import { loadEnv, env } from './env.js';
import { listen } from './http.js';
import { registerContactRoutes } from './contact-routes.js';
import { registerQuestionnaireRoutes } from './questionnaire-routes.js';
import { registerHookRoutes } from './hooks.js';
import { registerPanelRoutes } from './panel.js';
import { registerFormsRoutes } from './forms-routes.js';
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
registerHubDashboardRoutes();
registerRoteiroRoutes();
registerHookRoutes();

const port = Number(env('PORT', '8787'));
listen(port);
await startMessageWorker();
startLiveSync();
startScheduler();
startOdooPullScheduler();
console.log(`Vertice WEB em http://localhost:${port}`);
