import { syncContactsAndConversations } from './sync.js';

const EVERY_MS = 2000;
let running = false;

export function startLiveSync(): void {
  const run = () => {
    if (running) return;
    running = true;
    syncContactsAndConversations()
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'falha desconhecida';
        console.error(`sincronização automática: ${message}`);
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, EVERY_MS);
}
