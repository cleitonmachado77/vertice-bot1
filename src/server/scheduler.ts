import { env } from './env.js';
import { zonedNow } from './clock.js';
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
        const clock = zonedNow();
        const hh = String(Math.floor(clock.minutes / 60)).padStart(2, '0');
        const mm = String(clock.minutes % 60).padStart(2, '0');
        if (result.locked === false) {
          console.log(`agendamentos: ${clock.date} ${hh}:${mm} lock ocupado`);
          return;
        }
        const q = result.questionnaires;
        console.log(
          `agendamentos: ${clock.date} ${hh}:${mm} enviadas=${result.sent} falhas=${result.failed} aguardando=${result.waiting} ignoradas=${result.skipped}` +
            (q
              ? ` | questionários enviados=${q.sent} falhas=${q.failed} aguardando=${q.waiting} ignorados=${q.skipped}`
              : ''),
        );
        for (const item of result.items.slice(0, 20)) {
          if (
            item.status === 'failed' ||
            item.status === 'notified' ||
            item.status === 'sent' ||
            item.status === 'queued'
          ) {
            console.log(`agendamentos item: ${item.phone} → ${item.status} (${item.detail})`);
          }
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
