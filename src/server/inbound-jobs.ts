import { randomUUID } from 'node:crypto';
import { many, one, run, withTransaction } from './db.js';
import { unwrapEnvelope } from './map.js';

export type InboundJob = {
  id: string;
  event_id: string;
  message_id: string;
  conversation_id: string;
  payload_json: string;
  attempts: number;
};

export async function enqueueInboundJob(
  payload: unknown,
  deliveryId = '',
): Promise<{ id: string; duplicate: boolean }> {
  const envelope = unwrapEnvelope(payload);
  const data = (envelope.data || {}) as Record<string, unknown>;
  const message = (data.message || data) as Record<string, unknown>;
  const conversation = (data.conversation || {}) as Record<string, unknown>;
  const messageId = String(message.id || '');
  const eventId = String(envelope.id || deliveryId || messageId || randomUUID());
  const conversationId = String(conversation.id || data.conversationId || '');
  const id = randomUUID();
  const inserted = await many<{ id: string }>(
    `INSERT INTO inbound_jobs(
       id, event_id, message_id, conversation_id, payload_json, status, created_at, updated_at
     ) VALUES($1,$2,$3,$4,$5,'pending',NOW(),NOW())
     ON CONFLICT(event_id) DO NOTHING
     RETURNING id`,
    [id, eventId, messageId, conversationId, JSON.stringify(payload)],
  );
  return { id: inserted[0]?.id || eventId, duplicate: inserted.length === 0 };
}

export async function claimInboundJob(): Promise<InboundJob | undefined> {
  return withTransaction(async () => {
    const job = await one<InboundJob>(
      `SELECT j.id, j.event_id, j.message_id, j.conversation_id, j.payload_json, j.attempts
       FROM inbound_jobs j
       WHERE j.status IN ('pending', 'retry')
         AND j.available_at <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM inbound_jobs older
           WHERE older.conversation_id <> ''
             AND older.conversation_id = j.conversation_id
             AND older.status IN ('pending', 'retry', 'processing')
             AND (
               older.created_at < j.created_at OR
               (older.created_at = j.created_at AND older.id < j.id)
             )
         )
       ORDER BY j.created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (!job) return undefined;
    await run(
      `UPDATE inbound_jobs
       SET status = 'processing', attempts = attempts + 1, locked_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [job.id],
    );
    return { ...job, attempts: job.attempts + 1 };
  });
}

export async function completeInboundJob(id: string): Promise<void> {
  await run(
    `UPDATE inbound_jobs SET status = 'completed', locked_at = NULL, last_error = '', updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

export async function failInboundJob(job: InboundJob, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error || 'Falha desconhecida');
  const dead = job.attempts >= 6;
  const delaySeconds = Math.min(300, 2 ** Math.max(1, job.attempts));
  await run(
    `UPDATE inbound_jobs
     SET status = $2, locked_at = NULL, last_error = $3,
         available_at = NOW() + ($4 * INTERVAL '1 second'), updated_at = NOW()
     WHERE id = $1`,
    [job.id, dead ? 'dead' : 'retry', detail.slice(0, 1000), delaySeconds],
  );
}

export async function recoverInboundJobs(maxAgeMinutes = 10): Promise<number> {
  const rows = await many<{ id: string }>(
    `UPDATE inbound_jobs
     SET status = 'retry', locked_at = NULL, last_error = 'Worker interrompido', updated_at = NOW()
     WHERE status = 'processing' AND locked_at < NOW() - ($1 * INTERVAL '1 minute')
     RETURNING id`,
    [maxAgeMinutes],
  );
  return rows.length;
}

export async function retryInboundJob(id: string): Promise<boolean> {
  const rows = await many<{ id: string }>(
    `UPDATE inbound_jobs
     SET status = 'retry', attempts = 0, available_at = NOW(), locked_at = NULL,
         last_error = '', updated_at = NOW()
     WHERE id = $1 AND status IN ('dead', 'retry')
     RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
