import { initDatabase } from './db.js';
import { loadEnv, env } from './env.js';
import { listen } from './http.js';
import { registerContactRoutes } from './contact-routes.js';
import { registerQuestionnaireRoutes } from './questionnaire-routes.js';
import { registerHookRoutes } from './hooks.js';
import { registerPanelRoutes } from './panel.js';
import { startLiveSync } from './live-sync.js';
import { startScheduler } from './scheduler.js';

loadEnv();
await initDatabase();
registerPanelRoutes();
registerContactRoutes();
registerQuestionnaireRoutes();
registerHookRoutes();

const port = Number(env('PORT', '8787'));
listen(port);
startLiveSync();
startScheduler();
console.log(`Vertice Bot em http://localhost:${port}`);
