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
let timer: NodeJS.Timeout | undefined;
let running = false;

export async function processMessageQueues(): Promise<boolean> {
  if (running) return false;
  running = true;
  let processed = false;
  try {
    const inbound = await claimInboundJob();
    if (inbound) {
      processed = true;
      try {
        await handleInbound(JSON.parse(inbound.payload_json), inbound.event_id);
        await completeInboundJob(inbound.id);
      } catch (error) {
        await failInboundJob(inbound, error);
      }
    }
    if (await processNextOutbound()) processed = true;
    return processed;
  } finally {
    running = false;
  }
}

export async function startMessageWorker(): Promise<void> {
  if (env('ENABLE_MESSAGE_WORKER', '1').toLowerCase() === '0' || timer) return;
  const recovered = await recoverInboundJobs();
  const uncertain = await markStaleOutboundUncertain();
  if (recovered || uncertain) {
    console.warn(`filas: recuperados=${recovered} envios-incertos=${uncertain}`);
  }
  const tick = () => {
    processMessageQueues().catch((error) => {
      console.error(`filas: ${error instanceof Error ? error.message : error}`);
    });
  };
  timer = setInterval(tick, POLL_MS);
  timer.unref();
  tick();
}

export function stopMessageWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
