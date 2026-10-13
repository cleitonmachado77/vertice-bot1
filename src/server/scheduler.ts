import { env } from './env.js';
import { runDueDispatches } from './dispatch.js';

const EVERY_MS = 5 * 60 * 1000;
let running = false;

/** Em produção no Railway com Cron Job, use ENABLE_INTERNAL_SCHEDULER=0 no serviço web. */
export function startScheduler(): void {
  if (!internalSchedulerEnabled()) {
    console.log('agendamentos: scheduler interno desligado (use o Cron Job / npm run dispatch)');
    return;
  }

  const run = () => {
    if (running) return;
    running = true;
    runDueDispatches()
      .then((result) => {
        if (result.locked === false) {
          console.log('agendamentos: outro worker já está disparando');
          return;
        }
        if (result.sent || result.failed) {
          console.log(`agendamentos: ${result.sent} enviadas, ${result.failed} falharam`);
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'falha desconhecida';
        console.error(`agendamentos: ${message}`);
      })
      .finally(() => {
        running = false;
      });
  };

  setTimeout(run, 20_000);
  setInterval(run, EVERY_MS);
  console.log('agendamentos: scheduler interno a cada 5 minutos');
}

export function internalSchedulerEnabled(): boolean {
  const value = env('ENABLE_INTERNAL_SCHEDULER', '1').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}
