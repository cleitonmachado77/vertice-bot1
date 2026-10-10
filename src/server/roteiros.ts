import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';

const now = () => new Date().toISOString();

export type RoteiroRecord = {
  id: string;
  name: string;
  instructions: string;
  daily_message: string;
  send_time: string;
  active: number;
  updated_at: string;
};

export type DueContact = {
  id: string;
  name: string;
  phone: string;
  roteiro_id: string;
  daily_message: string;
  send_time: string;
};

export type DispatchRecord = {
  id: string;
  contact_id: string;
  contact_name: string;
  phone: string;
  roteiro_name: string;
  scheduled_for: string;
  status: string;
  error: string;
  sent_at: string;
  response_type: string;
  response_text: string;
  response_media_url: string;
  response_at: string;
};

export async function listRoteiros(): Promise<RoteiroRecord[]> {
  return many<RoteiroRecord>(
    `SELECT id, name, instructions, daily_message, send_time, active, updated_at
     FROM roteiros ORDER BY name`,
  );
}

export async function getRoteiro(id: string): Promise<RoteiroRecord | undefined> {
  return one<RoteiroRecord>(
    `SELECT id, name, instructions, daily_message, send_time, active, updated_at
     FROM roteiros WHERE id = $1`,
    [id],
  );
}

export async function saveRoteiro(input: {
  id?: string;
  name: string;
  instructions: string;
  dailyMessage: string;
  sendTime: string;
  active: boolean;
}): Promise<RoteiroRecord> {
  const id = input.id || randomUUID();
  const timestamp = now();
  await run(
    `INSERT INTO roteiros(id, name, instructions, daily_message, send_time, active, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       instructions = excluded.instructions,
       daily_message = excluded.daily_message,
       send_time = excluded.send_time,
       active = excluded.active,
       updated_at = excluded.updated_at`,
    [
      id,
      input.name,
      input.instructions,
      input.dailyMessage,
      input.sendTime,
      input.active ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );
  return (await getRoteiro(id)) as RoteiroRecord;
}

export async function deleteRoteiro(id: string): Promise<void> {
  await run('UPDATE contacts SET roteiro_id = $1 WHERE roteiro_id = $2', ['', id]);
  await run('DELETE FROM roteiros WHERE id = $1', [id]);
}

export async function listDueContacts(): Promise<DueContact[]> {
  return many<DueContact>(
    `SELECT c.id, c.name, c.phone, r.id AS roteiro_id, r.daily_message, r.send_time
     FROM contacts c
     JOIN roteiros r ON r.id = c.roteiro_id
     WHERE c.bot_enabled = 1 AND c.blocked = 0 AND c.phone <> ''
       AND r.active = 1 AND r.daily_message <> ''`,
  );
}

export async function dispatchStatus(contactId: string, day: string): Promise<string> {
  const row = await one<{ status: string }>(
    'SELECT status FROM dispatches WHERE contact_id = $1 AND scheduled_for = $2',
    [contactId, day],
  );
  return row?.status || '';
}

export async function markDispatch(input: {
  contactId: string;
  roteiroId: string;
  day: string;
  status: string;
  error?: string;
}): Promise<void> {
  await run(
    `INSERT INTO dispatches(id, contact_id, roteiro_id, scheduled_for, status, error, sent_at)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(contact_id, scheduled_for) DO UPDATE SET
       roteiro_id = excluded.roteiro_id,
       status = excluded.status,
       error = excluded.error,
       sent_at = excluded.sent_at`,
    [
      randomUUID(),
      input.contactId,
      input.roteiroId,
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
     WHERE contact_id = $5 AND scheduled_for = $6 AND status = 'sent'`,
    [input.type, input.text, input.mediaUrl, now(), contactId, day],
  );
}

export async function listDispatches(day: string): Promise<DispatchRecord[]> {
  return many<DispatchRecord>(
    `SELECT d.id, d.contact_id, c.name AS contact_name, c.phone, r.name AS roteiro_name,
            d.scheduled_for, d.status, d.error, d.sent_at, d.response_type, d.response_text,
            d.response_media_url, d.response_at
     FROM dispatches d
     LEFT JOIN contacts c ON c.id = d.contact_id
     LEFT JOIN roteiros r ON r.id = d.roteiro_id
     WHERE d.scheduled_for = $1
     ORDER BY d.sent_at DESC`,
    [day],
  );
}
