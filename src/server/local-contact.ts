import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { looksLikePhoneName, phonesMatch } from './phone.js';
import { getContact, type ContactRecord } from './store.js';

const now = () => new Date().toISOString();

export async function createLocalContact(input: {
  name: string;
  phone: string;
  email: string;
}): Promise<ContactRecord> {
  const existing = await findContactByPhone(input.phone);
  if (existing) {
    if (Number(existing.hidden) !== 1) throw new Error('Este número já está cadastrado');
    await run(
      'UPDATE contacts SET hidden = 0, name = $2, email = $3, updated_at = $4 WHERE id = $1',
      [existing.id, input.name, input.email, now()],
    );
    await run('UPDATE conversations SET hidden = 0 WHERE contact_id = $1', [existing.id]);
    return (await getContact(existing.id)) as ContactRecord;
  }
  const id = randomUUID();
  await run(
    `INSERT INTO contacts(
       id, name, phone, email, notes, prompt, instructions, tags_json, blocked, bot_enabled, roteiro_id, raw_json, updated_at
     ) VALUES($1, $2, $3, $4, '', '', '', '[]', 0, 1, '', '{}', $5)`,
    [id, input.name, input.phone, input.email, now()],
  );
  return (await getContact(id)) as ContactRecord;
}

export async function findContactByPhone(
  phone: string,
): Promise<{ id: string; hidden: number; name: string; phone: string } | undefined> {
  if (!phone.trim()) return undefined;
  const rows = await many<{ id: string; hidden: number; name: string; phone: string }>(
    'SELECT id, hidden, name, phone FROM contacts',
  );
  return rows.find((row) => phonesMatch(row.phone, phone));
}

/** Liga contato local ao ID da Névoa e preserva nome cadastrado. */
export async function linkRemoteContact(input: {
  remoteId: string;
  phone: string;
  remoteName: string;
}): Promise<{ id: string; name: string }> {
  const local = await findContactByPhone(input.phone);
  if (local && local.id !== input.remoteId) {
    await moveContact(local.id, input.remoteId);
  }
  const current = await getContact(input.remoteId);
  const bestName =
    current && !looksLikePhoneName(current.name)
      ? current.name
      : local && !looksLikePhoneName(local.name)
        ? local.name
        : !looksLikePhoneName(input.remoteName)
          ? input.remoteName
          : current?.name || local?.name || input.remoteName || input.phone;

  if (current) {
    if (current.name !== bestName || (input.phone && current.phone !== input.phone)) {
      await run('UPDATE contacts SET name = $2, phone = COALESCE(NULLIF($3, ""), phone), updated_at = $4 WHERE id = $1', [
        input.remoteId,
        bestName,
        input.phone,
        now(),
      ]);
    }
  }

  await run(
    `UPDATE conversations
     SET contact_id = $1,
         contact_name = CASE
           WHEN contact_name ~ '[[:alpha:]]' THEN contact_name
           ELSE $2
         END,
         contact_phone = COALESCE(NULLIF($3, ''), contact_phone)
     WHERE contact_id = $1
        OR ($3 <> '' AND contact_phone <> '' AND (
          right(regexp_replace(contact_phone, '[^0-9]', '', 'g'), 8)
            = right(regexp_replace($3, '[^0-9]', '', 'g'), 8)
        ))`,
    [input.remoteId, bestName, input.phone],
  );

  return { id: input.remoteId, name: bestName };
}

export async function moveContact(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const target = await getContact(toId);
  if (target) {
    const source = await getContact(fromId);
    if (source) await mergeContactFields(source, toId);
    await reassign(fromId, toId);
    await run('DELETE FROM contacts WHERE id = $1', [fromId]);
    return;
  }
  await reassign(fromId, toId);
  await run('UPDATE contacts SET id = $1 WHERE id = $2', [toId, fromId]);
}

async function mergeContactFields(source: ContactRecord, toId: string): Promise<void> {
  const target = await getContact(toId);
  const name =
    target && !looksLikePhoneName(target.name)
      ? target.name
      : !looksLikePhoneName(source.name)
        ? source.name
        : target?.name || source.name;
  await run(
    `UPDATE contacts SET
       name = $2,
       email = CASE WHEN email = '' THEN $3 ELSE email END,
       notes = CASE WHEN notes = '' THEN $4 ELSE notes END,
       prompt = CASE WHEN prompt = '' THEN $5 ELSE prompt END,
       instructions = CASE WHEN instructions = '' THEN $6 ELSE instructions END,
       phone = CASE WHEN phone = '' THEN $7 ELSE phone END
     WHERE id = $1`,
    [toId, name, source.email, source.notes, source.prompt, source.instructions, source.phone],
  );
}

async function reassign(fromId: string, toId: string): Promise<void> {
  await run('UPDATE contact_messages SET contact_id = $1 WHERE contact_id = $2', [toId, fromId]);
  await run('UPDATE dispatches SET contact_id = $1 WHERE contact_id = $2', [toId, fromId]);
  await run('UPDATE conversations SET contact_id = $1 WHERE contact_id = $2', [toId, fromId]);
  await run(
    `UPDATE questionnaire_assignments SET contact_id = $1
     WHERE contact_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM questionnaire_assignments x
         WHERE x.questionnaire_id = questionnaire_assignments.questionnaire_id AND x.contact_id = $1
       )`,
    [toId, fromId],
  );
  await run('DELETE FROM questionnaire_assignments WHERE contact_id = $1', [fromId]);
  await run('UPDATE questionnaire_cycles SET contact_id = $1 WHERE contact_id = $2', [toId, fromId]);
}
