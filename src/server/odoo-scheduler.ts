import { env } from './env.js';
import { odooConfigured } from './odoo-client.js';
import { pullFromOdoo } from './odoo-pull.js';
import { internalSchedulerEnabled } from './scheduler.js';

const EVERY_MS = 5 * 60 * 1000;
let running = false;

/** Pull automático Odoo → Vertice (somente leitura). Push continua manual. */
export function startOdooPullScheduler(): void {
  if (!internalSchedulerEnabled()) return;
  if (env('ENABLE_ODOO_AUTO_PULL', '1').trim().toLowerCase() === '0') {
    console.log('odoo-pull: scheduler desligado (ENABLE_ODOO_AUTO_PULL=0)');
    return;
  }

  const run = () => {
    if (running) return;
    if (!odooConfigured()) return;
    running = true;
    // auto:true evita corrida com "Receber dados" manual e respeita throttle
    pullFromOdoo({ auto: true })
      .then((result) => {
        if (result.skipped) {
          console.log('odoo-pull: automático ignorado (throttle)');
          return;
        }
        console.log(
          `odoo-pull: mode=${result.mode || 'full'} empresas=${result.companies} produtos=${result.products} parceiros=${result.partners} vendas=${result.sales} compras=${result.purchases} estoque=${result.stockUpdated}`,
        );
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'falha desconhecida';
        console.error(`odoo-pull: ${message}`);
      })
      .finally(() => {
        running = false;
      });
  };

  setTimeout(run, 45_000);
  setInterval(run, EVERY_MS);
  console.log('odoo-pull: sync automático a cada 5 minutos');
}
