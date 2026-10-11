import { runDueDispatches } from './dispatch.js';

const EVERY_MS = 5 * 60 * 1000;
let running = false;

export function startScheduler(): void {
  const run = () => {
    if (running) return;
    running = true;
    runDueDispatches()
      .then((result) => {
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
}
