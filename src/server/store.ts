import { unhideConversation } from './conversation-visibility.js';
import { many, one, run } from './db.js';

const now = () => new Date().toISOString();

function hasLetters(value: string): boolean {
  return /\p{L}/u.test(value);
}

function preferNamed(current: string, incoming: string): string {
  if (hasLetters(current) && !hasLetters(incoming)) return current;
  return incoming;
}

function sameText(current: string | null | undefined, next: string): boolean {
  return String(current || '') === String(next || '');
}

export type ContactRecord = {
  id: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  prompt: string;
  instructions: string;
  bot_enabled: number;
  human_handoff: number;
  blocked: number;
  tags_json: string;
  roteiro_id: string;
  message_count: number;
  updated_at: string;
};

export type ConversationRecord = {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_phone: string;
  status: string;
  preview: string;
  last_message_at: string;
  channel_id: string;
  human_handoff: number;
  updated_at: string;
};

export type MessageRecord = {
  id: string;
  conversation_id: string;
  direction: string;
  type: string;
  text: string;
  media_url: string;
  created_at: string;
  origin: string;
};

export async function upsertContact(input: {
  id: string;
  name: string;
  phone: string;
  email: string;
  tags: string[];
  blocked: boolean;
  raw: unknown;
}): Promise<void> {
  const existing = await one<{ name: string; phone: string; email: string; tags_json: string; blocked: number }>(
    'SELECT name, phone, email, tags_json, blocked FROM contacts WHERE id = $1',
    [input.id],
  );
  const name = existing ? preferNamed(existing.name, input.name) : input.name;
  const phone = existing && input.phone === '' ? existing.phone : input.phone;
  const email = existing && input.email === '' ? existing.email : input.email;
  const tags = JSON.stringify(input.tags);
  const blocked = input.blocked ? 1 : 0;
  if (
    existing &&
    existing.name === name &&
    existing.phone === phone &&
    existing.email === email &&
    existing.tags_json === tags &&
    Number(existing.blocked) === blocked
  ) {
    return;
  }
  await run(
    `INSERT INTO contacts(id, name, phone, email, tags_json, blocked, raw_json, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       phone = excluded.phone,
       email = excluded.email,
       tags_json = excluded.tags_json,
       blocked = excluded.blocked,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
    [input.id, name, phone, email, tags, blocked, JSON.stringify(input.raw), now()],
  );
}

export async function listContacts(search = ''): Promise<ContactRecord[]> {
  const like = `%${search.trim()}%`;
  return many<ContactRecord>(
    `SELECT id, name, phone, email, notes, prompt, instructions, bot_enabled, human_handoff, blocked, tags_json, roteiro_id,
            updated_at,
            (SELECT COUNT(*)::int
             FROM messages msg
             JOIN conversations conv ON conv.id = msg.conversation_id
             WHERE conv.hidden = 0
               AND (
                 conv.contact_id = contacts.id
                 OR (
                   regexp_replace(contacts.phone, '[^0-9]', '', 'g') <> ''
                   AND right(regexp_replace(conv.contact_phone, '[^0-9]', '', 'g'), 11)
                       = right(regexp_replace(contacts.phone, '[^0-9]', '', 'g'), 11)
                 )
               )) AS message_count
     FROM contacts
     WHERE name ILIKE $1 OR phone ILIKE $1 OR notes ILIKE $1
     ORDER BY updated_at DESC`,
    [like],
  );
}

export async function getContact(id: string): Promise<ContactRecord | undefined> {
  return one<ContactRecord>(
    `SELECT id, name, phone, email, notes, prompt, instructions, bot_enabled, human_handoff, blocked, tags_json, roteiro_id,
            updated_at, 0 AS message_count
     FROM contacts WHERE id = $1`,
    [id],
  );
}

export async function setHumanHandoff(contactId: string, active: boolean): Promise<void> {
  await run('UPDATE contacts SET human_handoff = $1 WHERE id = $2', [active ? 1 : 0, contactId]);
}

export async function insertContactIfMissing(input: {
  id: string;
  name: string;
  phone: string;
}): Promise<void> {
  await run(
    `INSERT INTO contacts(id, name, phone, email, tags_json, blocked, raw_json, updated_at)
     VALUES($1, $2, $3, '', '[]', 0, '{}', $4)
     ON CONFLICT(id) DO NOTHING`,
    [input.id, input.name, input.phone, now()],
  );
}

export async function upsertConversation(input: {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  status: string;
  preview: string;
  lastMessageAt: string;
  channelId: string;
  raw: unknown;
}): Promise<boolean> {
  const existing = await one<{
    contact_id: string;
    contact_name: string;
    contact_phone: string;
    status: string;
    preview: string;
    last_message_at: string;
    channel_id: string;
  }>(
    `SELECT contact_id, contact_name, contact_phone, status, preview, last_message_at, channel_id
     FROM conversations WHERE id = $1`,
    [input.id],
  );
  const contactName = existing ? preferNamed(existing.contact_name, input.contactName) : input.contactName;
  if (
    existing &&
    sameText(existing.contact_id, input.contactId) &&
    existing.contact_name === contactName &&
    sameText(existing.contact_phone, input.contactPhone) &&
    sameText(existing.status, input.status) &&
    sameText(existing.preview, input.preview) &&
    sameText(existing.last_message_at, input.lastMessageAt) &&
    sameText(existing.channel_id, input.channelId)
  ) {
    return false;
  }
  await run(
    `INSERT INTO conversations(
       id, contact_id, contact_name, contact_phone, status, preview, last_message_at, channel_id, raw_json, updated_at
     ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(id) DO UPDATE SET
       contact_id = excluded.contact_id,
       contact_name = excluded.contact_name,
       contact_phone = excluded.contact_phone,
       status = excluded.status,
       preview = excluded.preview,
       last_message_at = excluded.last_message_at,
       channel_id = excluded.channel_id,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
    [
      input.id,
      input.contactId,
      contactName,
      input.contactPhone,
      input.status,
      input.preview,
      input.lastMessageAt,
      input.channelId,
      JSON.stringify(input.raw),
      now(),
    ],
  );
  return true;
}

const personKey = `COALESCE(NULLIF(conversations.contact_id, ''), NULLIF(conversations.contact_phone, ''), conversations.id)`;

export async function listConversations(): Promise<ConversationRecord[]> {
  return many<ConversationRecord>(
    `SELECT id, contact_id, contact_name, contact_phone, status, preview, last_message_at, channel_id, updated_at, human_handoff
     FROM (
       SELECT DISTINCT ON (${personKey})
              conversations.id, conversations.contact_id, conversations.contact_name, conversations.contact_phone,
              conversations.status, conversations.preview, conversations.last_message_at, conversations.channel_id,
              conversations.updated_at, COALESCE(contacts.human_handoff, 0) AS human_handoff
       FROM conversations
       LEFT JOIN contacts ON contacts.id = conversations.contact_id
       WHERE conversations.hidden = 0
       ORDER BY ${personKey}, conversations.last_message_at DESC
     ) people
     ORDER BY last_message_at DESC`,
  );
}

export async function getConversation(id: string): Promise<ConversationRecord | undefined> {
  return one<ConversationRecord>(
    `SELECT conversations.id, conversations.contact_id, conversations.contact_name, conversations.contact_phone,
            conversations.status, conversations.preview, conversations.last_message_at, conversations.channel_id,
            conversations.updated_at, COALESCE(contacts.human_handoff, 0) AS human_handoff
     FROM conversations
     LEFT JOIN contacts ON contacts.id = conversations.contact_id
     WHERE conversations.id = $1`,
    [id],
  );
}

export async function upsertMessage(input: {
  id: string;
  conversationId: string;
  direction: string;
  type: string;
  text: string;
  mediaUrl?: string;
  createdAt: string;
  origin?: string;
  raw: unknown;
}): Promise<boolean> {
  const inserted = await one<{ id: string }>(
    `INSERT INTO messages(id, conversation_id, direction, type, text, media_url, created_at, raw_json, origin)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
    [
      input.id,
      input.conversationId,
      input.direction,
      input.type,
      input.text,
      input.mediaUrl || '',
      input.createdAt,
      JSON.stringify(input.raw),
      input.origin || 'contact',
    ],
  );
  if (inserted) {
    await unhideConversation(input.conversationId);
    return true;
  }
  await run(
    `UPDATE messages SET
       text = $2,
       direction = $3,
       type = $4,
       media_url = $5,
       raw_json = $6,
       origin = CASE
         WHEN origin IN ('manual', 'agent', 'scheduled') THEN origin
         ELSE $7
       END
     WHERE id = $1`,
    [
      input.id,
      input.text,
      input.direction,
      input.type,
      input.mediaUrl || '',
      JSON.stringify(input.raw),
      input.origin || 'contact',
    ],
  );
  return false;
}

const samePerson = `
  SELECT id FROM conversations
  WHERE id = $1
     OR (contact_id <> '' AND contact_id = (SELECT contact_id FROM conversations WHERE id = $1))
     OR (contact_phone <> '' AND contact_phone = (SELECT contact_phone FROM conversations WHERE id = $1))
`;

export async function listMessages(conversationId: string): Promise<MessageRecord[]> {
  return many<MessageRecord>(
    `SELECT id, conversation_id, direction, type, text, media_url, created_at, origin
     FROM messages WHERE conversation_id IN (${samePerson}) ORDER BY created_at ASC`,
    [conversationId],
  );
}

export async function recentMessages(conversationId: string, limit: number): Promise<MessageRecord[]> {
  const rows = await many<MessageRecord>(
    `SELECT id, conversation_id, direction, type, text, media_url, created_at, origin
     FROM messages WHERE conversation_id IN (${samePerson}) ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

export async function hasEvent(id: string): Promise<boolean> {
  const row = await one<{ id: string }>('SELECT id FROM events WHERE id = $1', [id]);
  return Boolean(row);
}

export async function insertEvent(input: {
  id: string;
  event: string;
  status: string;
  summary: string;
  payload: unknown;
  result: unknown;
}): Promise<void> {
  await run(
    `INSERT INTO events(id, event, status, summary, payload_json, result_json, created_at)
     VALUES($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.event,
      input.status,
      input.summary,
      JSON.stringify(input.payload),
      JSON.stringify(input.result),
      now(),
    ],
  );
}

export async function listEvents(limit = 80) {
  return many<{
    id: string;
    event: string;
    status: string;
    summary: string;
    payload_json: string;
    result_json: string;
    created_at: string;
  }>(
    `SELECT id, event, status, summary, payload_json, result_json, created_at
     FROM events ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

export async function dashboardCounts() {
  const contacts = await one<{ total: number }>('SELECT COUNT(*)::int AS total FROM contacts');
  const conversations = await one<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM (
       SELECT DISTINCT COALESCE(NULLIF(contact_id, ''), NULLIF(contact_phone, ''), id) AS person
       FROM conversations
       WHERE hidden = 0
     ) people`,
  );
  const events = await one<{ total: number }>('SELECT COUNT(*)::int AS total FROM events');
  return {
    contacts: contacts?.total ?? 0,
    conversations: conversations?.total ?? 0,
    events: events?.total ?? 0,
  };
}
