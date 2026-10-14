import { randomUUID } from 'node:crypto';
import { many, one, run, withTransaction } from './db.js';
import { moveContact } from './local-contact.js';
import { NevoaError, sendWhatsappTemplate, sendWhatsappText } from './nevoa.js';
import {
  markCycleNotified,
  markCyclePrompted,
  setConversationCycleContext,
} from './questionnaire-cycles.js';
import { looksLikeHumanHandoff } from './human-handoff.js';
import { getContact, setAwaitingHuman, upsertConversation } from './store.js';
import { ensureConversation, recordOutbound } from './thread.js';

export type OutboundKind = 'text' | 'template';

export type OutboundJob = {
  id: string;
  dedupe_key: string;
  kind: OutboundKind;
  phone: string;
  text: string;
  template_id: string;
  variables_json: string;
  channel_id: string;
  conversation_id: string;
  contact_id: string;
  cycle_id: string;
  origin: 'agent' | 'scheduled';
  raw_json: string;
  attempts: number;
};

export async function enqueueOutbound(input: {
  dedupeKey: string;
  kind: OutboundKind;
  phone: string;
  text?: string;
  templateId?: string;
  variables?: string[];
  channelId?: string;
  conversationId?: string;
  contactId?: string;
  cycleId?: string;
  origin: 'agent' | 'scheduled';
  raw?: unknown;
}): Promise<{ id: string; duplicate: boolean }> {
  const id = randomUUID();
  const rows = await many<{ id: string }>(
    `INSERT INTO outbound_outbox(
       id, dedupe_key, kind, phone, text, template_id, variables_json, channel_id,
       conversation_id, contact_id, cycle_id, origin, raw_json, status, created_at, updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',NOW(),NOW())
     ON CONFLICT(dedupe_key) DO NOTHING
     RETURNING id`,
    [
      id,
      input.dedupeKey,
      input.kind,
      input.phone,
      input.text || '',
      input.templateId || '',
      JSON.stringify(input.variables || []),
      input.channelId || '',
      input.conversationId || '',
      input.contactId || '',
      input.cycleId || '',
      input.origin,
      JSON.stringify(input.raw || {}),
    ],
  );
  return { id: rows[0]?.id || input.dedupeKey, duplicate: rows.length === 0 };
}

export async function processNextOutbound(): Promise<boolean> {
  const job = await claimOutbound();
  if (!job) return false;
  let response: unknown;
  try {
    response =
      job.kind === 'template'
        ? await sendWhatsappTemplate({
            templateId: job.template_id,
            phone: job.phone,
            variables: parseArray(job.variables_json),
            channelIntegrationId: job.channel_id || undefined,
          })
        : await sendWhatsappText({
            phone: job.phone,
            text: job.text,
            channelIntegrationId: job.channel_id || undefined,
          });
  } catch (error) {
    await failOutbound(job, error);
    return true;
  }
  try {
    await finalizeOutbound(job, response);
  } catch (error) {
    await markOutboundUncertain(job, response, error);
  }
  return true;
}

async function claimOutbound(): Promise<OutboundJob | undefined> {
  return withTransaction(async () => {
    const job = await one<OutboundJob>(
      `SELECT id, dedupe_key, kind, phone, text, template_id, variables_json, channel_id,
              conversation_id, contact_id, cycle_id, origin, raw_json, attempts
       FROM outbound_outbox
       WHERE status IN ('pending', 'retry') AND available_at <= NOW()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (!job) return undefined;
    await run(
      `UPDATE outbound_outbox
       SET status = 'sending', attempts = attempts + 1, locked_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [job.id],
    );
    return { ...job, attempts: job.attempts + 1 };
  });
}

async function finalizeOutbound(job: OutboundJob, response: unknown): Promise<void> {
  await withTransaction(async () => {
    const sent = (response || {}) as {
      conversation?: { id?: string; status?: string };
      contact?: { id?: string };
    };
    let contactId = job.contact_id;
    const remoteId = String(sent.contact?.id || '');
    if (remoteId && contactId && remoteId !== contactId) {
      await moveContact(contactId, remoteId);
      contactId = remoteId;
    }
    const contact = contactId ? await getContact(contactId) : undefined;
    const conversationId =
      String(sent.conversation?.id || '') ||
      job.conversation_id ||
      (contactId
        ? await ensureConversation({
            contactId,
            name: contact?.name || job.phone,
            phone: job.phone,
            channelId: job.channel_id,
          })
        : '');

    if (conversationId && contactId) {
      await upsertConversation({
        id: conversationId,
        contactId,
        contactName: contact?.name || job.phone,
        contactPhone: job.phone,
        status: String(sent.conversation?.status || 'OPEN'),
        preview: job.text,
        lastMessageAt: new Date().toISOString(),
        channelId: job.channel_id,
        raw: response,
      });
    }
    if (conversationId && job.text) {
      await recordOutbound({
        conversationId,
        text: job.text,
        origin: job.origin,
        raw: { ...parseObject(job.raw_json), outboxId: job.id, provider: response },
      });
    }
    if (
      job.origin === 'agent' &&
      contactId &&
      job.kind === 'text' &&
      looksLikeHumanHandoff(job.text || '')
    ) {
      await setAwaitingHuman(contactId, true);
    }
    if (job.cycle_id && job.origin === 'scheduled') await markCycleNotified(job.cycle_id);
    else if (job.cycle_id) await markCyclePrompted(job.cycle_id);
    if (job.cycle_id && conversationId) {
      await setConversationCycleContext(conversationId, job.cycle_id);
    }
    await run(
      `UPDATE outbound_outbox
       SET status = 'sent', locked_at = NULL, error = '', response_json = $2, updated_at = NOW()
       WHERE id = $1`,
      [job.id, JSON.stringify(response || {})],
    );
  });
}

async function failOutbound(job: OutboundJob, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error || 'Falha desconhecida');
  const permanent = error instanceof NevoaError && error.status >= 400 && error.status < 500;
  const dead = permanent || job.attempts >= 6;
  const delaySeconds = Math.min(300, 2 ** Math.max(1, job.attempts));
  await run(
    `UPDATE outbound_outbox
     SET status = $2, locked_at = NULL, error = $3,
         available_at = NOW() + ($4 * INTERVAL '1 second'), updated_at = NOW()
     WHERE id = $1`,
    [job.id, dead ? 'dead' : 'retry', detail.slice(0, 1000), delaySeconds],
  );
}

async function markOutboundUncertain(
  job: OutboundJob,
  response: unknown,
  error: unknown,
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error || 'Falha ao confirmar envio');
  await withTransaction(async () => {
    await run(
      `UPDATE outbound_outbox
       SET status = 'uncertain', locked_at = NULL, error = $2,
           response_json = $3, updated_at = NOW()
       WHERE id = $1`,
      [job.id, `Mensagem aceita pelo provedor; persistência local falhou: ${detail}`.slice(0, 1000), JSON.stringify(response || {})],
    );
    if (job.cycle_id) {
      await run(
        `UPDATE questionnaire_cycles
         SET status = 'delivery_unknown', error = $2, updated_at = $3
         WHERE id = $1 AND status = 'sending'`,
        [job.cycle_id, 'Envio confirmado pelo provedor; finalização local pendente', new Date().toISOString()],
      );
    }
  });
}

export async function markStaleOutboundUncertain(maxAgeMinutes = 10): Promise<number> {
  return withTransaction(async () => {
    const rows = await many<{ id: string; cycle_id: string }>(
      `UPDATE outbound_outbox
       SET status = 'uncertain', locked_at = NULL,
           error = 'Processo interrompido durante envio; reenvio automático bloqueado',
           updated_at = NOW()
       WHERE status = 'sending' AND locked_at < NOW() - ($1 * INTERVAL '1 minute')
       RETURNING id, cycle_id`,
      [maxAgeMinutes],
    );
    const cycleIds = rows.map((row) => row.cycle_id).filter(Boolean);
    if (cycleIds.length) {
      await run(
        `UPDATE questionnaire_cycles
         SET status = 'delivery_unknown',
             error = 'Envio incerto; reenvio automático bloqueado', updated_at = $2
         WHERE id = ANY($1::text[]) AND status = 'sending'`,
        [cycleIds, new Date().toISOString()],
      );
    }
    return rows.length;
  });
}

export async function retryOutbound(id: string): Promise<boolean> {
  const rows = await many<{ id: string }>(
    `UPDATE outbound_outbox
     SET status = 'retry', attempts = 0, available_at = NOW(), locked_at = NULL,
         error = '', updated_at = NOW()
     WHERE id = $1 AND status IN ('dead', 'retry')
     RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
