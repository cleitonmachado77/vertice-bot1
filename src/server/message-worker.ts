import { env } from './env.js';
import {
  claimInboundJob,
  completeInboundJob,
  failInboundJob,
  recoverInboundJobs,
} from './inbound-jobs.js';
import { markStaleOutboundUncertain, processNextOutbound } from './outbound-outbox.js';
import { handleInbound } from './pipeline.js';

const POLL_MS = 300;
/** Conversas diferentes seguem em paralelo. A mesma conversa continua em ordem. */
const INBOUND_LIMIT = 3;

let timer: NodeJS.Timeout | undefined;
let stopped = false;
let inboundActive = 0;
let outboundLoop: Promise<void> | undefined;

export async function processMessageQueues(): Promise<boolean> {
  pumpInbound(true);
  pumpOutbound();
  return inboundActive > 0 || Boolean(outboundLoop);
}

export async function startMessageWorker(): Promise<void> {
  if (env('ENABLE_MESSAGE_WORKER', '1').toLowerCase() === '0' || timer) return;
  stopped = false;
  const recovered = await recoverInboundJobs();
  const uncertain = await markStaleOutboundUncertain();
  if (recovered || uncertain) {
    console.warn(`filas: recuperados=${recovered} envios-incertos=${uncertain}`);
  }
  timer = setInterval(() => {
    pumpInbound(false);
    pumpOutbound();
  }, POLL_MS);
  timer.unref();
  pumpInbound(true);
  pumpOutbound();
}

/** Acorda a fila assim que uma mensagem entra, sem esperar o próximo ciclo de 300 ms. */
export function wakeMessageWorker(): void {
  pumpInbound(true);
  pumpOutbound();
}

export function stopMessageWorker(): void {
  stopped = true;
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

function pumpInbound(fill: boolean): void {
  if (stopped || inboundActive >= INBOUND_LIMIT) return;
  // Ocioso: uma sonda só. Com mensagem na fila, ocupa os demais slots.
  if (!fill && inboundActive > 0) return;
  inboundActive += 1;
  void runOneInbound();
}

async function runOneInbound(): Promise<void> {
  let claimed = false;
  try {
    const inbound = await claimInboundJob();
    if (!inbound) return;
    claimed = true;
    pumpInbound(true);
    const started = Date.now();
    try {
      const decision = await handleInbound(JSON.parse(inbound.payload_json), inbound.event_id);
      await completeInboundJob(inbound.id);
      console.log(
        `bot: ${Date.now() - started}ms ${decision.action} ${decision.source} ${decision.reason}`.slice(0, 240),
      );
    } catch (error) {
      await failInboundJob(inbound, error);
      console.error(
        `bot: ${Date.now() - started}ms falha ${error instanceof Error ? error.message : error}`,
      );
    }
  } catch (error) {
    console.error(`filas: ${error instanceof Error ? error.message : error}`);
  } finally {
    inboundActive -= 1;
    if (claimed && !stopped) {
      pumpOutbound();
      pumpInbound(true);
    }
  }
}

function pumpOutbound(): void {
  if (stopped || outboundLoop) return;
  outboundLoop = drainOutbound().finally(() => {
    outboundLoop = undefined;
  });
}

async function drainOutbound(): Promise<void> {
  try {
    while (!stopped && (await processNextOutbound())) {
      // esvazia o que já está pronto, sem esperar a próxima resposta ser gerada
    }
  } catch (error) {
    console.error(`filas: ${error instanceof Error ? error.message : error}`);
  }
}
