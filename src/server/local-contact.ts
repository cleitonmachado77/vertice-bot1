import { randomUUID } from 'node:crypto';
import { one, run } from './db.js';
import { getContact, type ContactRecord } from './store.js';

const now = () => new Date().toISOString();

export async function createLocalContact(input: {
  name: string;
  phone: string;
  email: string;
}): Promise<ContactRecord> {
  const existing = await getContactByPhone(input.phone);
  if (existing) throw new Error('Este número já está cadastrado');
  const id = randomUUID();
  await run(
    `INSERT INTO contacts(
       id, name, phone, email, notes, prompt, instructions, tags_json, blocked, bot_enabled, roteiro_id, raw_json, updated_at
     ) VALUES($1, $2, $3, $4, '', '', '', '[]', 0, 1, '', '{}', $5)`,
    [id, input.name, input.phone, input.email, now()],
  );
  return (await getContact(id)) as ContactRecord;
}

async function getContactByPhone(phone: string): Promise<{ id: string } | undefined> {
  return one<{ id: string }>('SELECT id FROM contacts WHERE phone = $1', [phone]);
}

export async function moveContact(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const target = await getContact(toId);
  if (target) {
    const source = await getContact(fromId);
    if (source) await copyBlankFields(source, toId);
    await reassign(fromId, toId);
    await run('DELETE FROM contacts WHERE id = $1', [fromId]);
    return;
  }
  await reassign(fromId, toId);
  await run('UPDATE contacts SET id = $1 WHERE id = $2', [toId, fromId]);
}

async function copyBlankFields(source: ContactRecord, toId: string): Promise<void> {
  await run(
    `UPDATE contacts SET
       name = CASE WHEN name = '' THEN $2 ELSE name END,
       email = CASE WHEN email = '' THEN $3 ELSE email END,
       notes = CASE WHEN notes = '' THEN $4 ELSE notes END,
       prompt = CASE WHEN prompt = '' THEN $5 ELSE prompt END,
       instructions = CASE WHEN instructions = '' THEN $6 ELSE instructions END
     WHERE id = $1`,
    [toId, source.name, source.email, source.notes, source.prompt, source.instructions],
  );
}

async function reassign(fromId: string, toId: string): Promise<void> {
  await run('UPDATE contact_messages SET contact_id = $1 WHERE contact_id = $2', [toId, fromId]);
  await run('UPDATE dispatches SET contact_id = $1 WHERE contact_id = $2', [toId, fromId]);
  await run('UPDATE conversations SET contact_id = $1 WHERE contact_id = $2', [toId, fromId]);
}
