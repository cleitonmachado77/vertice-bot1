import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';

const now = () => new Date().toISOString();
const FREQUENCIES = new Set(['daily', 'weekdays', 'weekly']);

export type PlannedMessage = {
  id: string;
  contact_id: string;
  body: string;
  frequency: string;
  weekday: number;
  send_time: string;
  active: number;
};

export type DueMessage = PlannedMessage & {
  name: string;
  phone: string;
};

export type PlanInput = {
  name?: string;
  phone?: string;
  email?: string;
  prompt: string;
  instructions: string;
  notes: string;
  botEnabled: boolean;
  messages: {
    id?: string;
    body: string;
    frequency: string;
    weekday: number;
    sendTime: string;
    active: boolean;
  }[];
};

export async function listContactMessages(contactId: string): Promise<PlannedMessage[]> {
  return many<PlannedMessage>(
    `SELECT id, contact_id, body, frequency, weekday, send_time, active
     FROM contact_messages WHERE contact_id = $1 ORDER BY send_time, created_at`,
    [contactId],
  );
}

export async function updateContactBasics(
  contactId: string,
  input: { name?: string; phone?: string; email?: string; botEnabled: boolean },
): Promise<void> {
  const found = await one<{ id: string }>('SELECT id FROM contacts WHERE id = $1', [contactId]);
  if (!found) throw new Error('Contato não encontrado');
  await run(
    `UPDATE contacts SET name = $1, phone = COALESCE($2, phone), email = $3, bot_enabled = $4 WHERE id = $5`,
    [input.name || '', input.phone || null, input.email ?? '', input.botEnabled ? 1 : 0, contactId],
  );
  await run('UPDATE conversations SET contact_name = $1, contact_phone = COALESCE($2, contact_phone) WHERE contact_id = $3', [
    input.name || '',
    input.phone || null,
    contactId,
  ]);
}

export async function saveContactPlan(contactId: string, input: PlanInput): Promise<void> {
  await updateContactBasics(contactId, {
    name: input.name,
    phone: input.phone,
    email: input.email,
    botEnabled: input.botEnabled,
  });
  await run(`UPDATE contacts SET prompt = $1, instructions = $2, notes = $3 WHERE id = $4`, [
    input.prompt,
    input.instructions,
    input.notes,
    contactId,
  ]);

  const messages = input.messages.filter((item) => item.body.trim());
  for (const item of messages) {
    if (!FREQUENCIES.has(item.frequency)) throw new Error('Frequência inválida');
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(item.sendTime)) throw new Error('Horário inválido. Use HH:MM');
    if (item.weekday < 0 || item.weekday > 6) throw new Error('Dia da semana inválido');
  }

  const ids = messages.map((item) => item.id).filter((id): id is string => Boolean(id));
  if (ids.length) {
    await run('DELETE FROM contact_messages WHERE contact_id = $1 AND NOT (id = ANY($2::text[]))', [contactId, ids]);
  } else {
    await run('DELETE FROM contact_messages WHERE contact_id = $1', [contactId]);
  }

  for (const item of messages) {
    const id = item.id || randomUUID();
    await run(
      `INSERT INTO contact_messages(id, contact_id, body, frequency, weekday, send_time, active, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(id) DO UPDATE SET
         body = excluded.body,
         frequency = excluded.frequency,
         weekday = excluded.weekday,
         send_time = excluded.send_time,
         active = excluded.active`,
      [id, contactId, item.body.trim(), item.frequency, item.weekday, item.sendTime, item.active ? 1 : 0, now()],
    );
  }
}

export async function listDueMessages(): Promise<DueMessage[]> {
  return many<DueMessage>(
    `SELECT m.id, m.contact_id, m.body, m.frequency, m.weekday, m.send_time, m.active, c.name, c.phone
     FROM contact_messages m
     JOIN contacts c ON c.id = m.contact_id
     WHERE m.active = 1 AND m.body <> '' AND c.bot_enabled = 1 AND c.blocked = 0 AND c.hidden = 0 AND c.phone <> ''`,
  );
}

export function runsOnWeekday(message: { frequency: string; weekday: number }, weekday: number): boolean {
  if (message.frequency === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (message.frequency === 'weekly') return message.weekday === weekday;
  return true;
}

export async function dispatchStatus(messageId: string, day: string): Promise<string> {
  const row = await one<{ status: string }>(
    'SELECT status FROM dispatches WHERE message_id = $1 AND scheduled_for = $2',
    [messageId, day],
  );
  return row?.status || '';
}

export async function markDispatch(input: {
  contactId: string;
  messageId: string;
  day: string;
  status: string;
  error?: string;
}): Promise<void> {
  await run(
    `INSERT INTO dispatches(id, contact_id, roteiro_id, message_id, scheduled_for, status, error, sent_at)
     VALUES($1, $2, '', $3, $4, $5, $6, $7)
     ON CONFLICT(message_id, scheduled_for) DO UPDATE SET
       status = excluded.status,
       error = excluded.error,
       sent_at = excluded.sent_at`,
    [
      randomUUID(),
      input.contactId,
      input.messageId,
      input.day,
      input.status,
      input.error || '',
      input.status === 'sent' ? now() : '',
    ],
  );
}

export async function attachCollectedResponse(
  contactId: string,
  day: string,
  input: { type: string; text: string; mediaUrl: string },
): Promise<void> {
  await run(
    `UPDATE dispatches
     SET status = 'answered', response_type = $1, response_text = $2, response_media_url = $3, response_at = $4
     WHERE id = (
       SELECT id FROM dispatches
       WHERE contact_id = $5 AND scheduled_for = $6 AND status = 'sent'
       ORDER BY sent_at DESC
       LIMIT 1
     )`,
    [input.type, input.text, input.mediaUrl, now(), contactId, day],
  );
}

export async function listContactDispatches(contactId: string, day: string) {
  return many<{
    id: string;
    status: string;
    error: string;
    sent_at: string;
    response_type: string;
    response_text: string;
    body: string;
    send_time: string;
  }>(
    `SELECT d.id, d.status, d.error, d.sent_at, d.response_type, d.response_text, m.body, m.send_time
     FROM dispatches d
     LEFT JOIN contact_messages m ON m.id = d.message_id
     WHERE d.contact_id = $1 AND d.scheduled_for = $2
     ORDER BY d.sent_at DESC`,
    [contactId, day],
  );
}
