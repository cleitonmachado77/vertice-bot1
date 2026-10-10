import { many, one, run } from './db.js';

const now = () => new Date().toISOString();

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
  await run(
    `INSERT INTO contacts(id, name, phone, email, tags_json, blocked, raw_json, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id) DO UPDATE SET
       name = CASE
         WHEN contacts.name ~ '[[:alpha:]]' AND excluded.name !~ '[[:alpha:]]' THEN contacts.name
         ELSE excluded.name
       END,
       phone = CASE WHEN excluded.phone = '' THEN contacts.phone ELSE excluded.phone END,
       email = CASE WHEN excluded.email = '' THEN contacts.email ELSE excluded.email END,
       tags_json = excluded.tags_json,
       blocked = excluded.blocked,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
    [
      input.id,
      input.name,
      input.phone,
      input.email,
      JSON.stringify(input.tags),
      input.blocked ? 1 : 0,
      JSON.stringify(input.raw),
      now(),
    ],
  );
}

export async function listContacts(search = ''): Promise<ContactRecord[]> {
  const like = `%${search.trim()}%`;
  return many<ContactRecord>(
    `SELECT id, name, phone, email, notes, prompt, instructions, bot_enabled, human_handoff, blocked, tags_json, roteiro_id,
            updated_at,
            (SELECT COUNT(*)::int FROM contact_messages m WHERE m.contact_id = contacts.id) AS message_count
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
}): Promise<void> {
  await run(
    `INSERT INTO conversations(
       id, contact_id, contact_name, contact_phone, status, preview, last_message_at, channel_id, raw_json, updated_at
     ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(id) DO UPDATE SET
       contact_id = excluded.contact_id,
       contact_name = CASE
         WHEN conversations.contact_name ~ '[[:alpha:]]' AND excluded.contact_name !~ '[[:alpha:]]' THEN conversations.contact_name
         ELSE excluded.contact_name
       END,
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
      input.contactName,
      input.contactPhone,
      input.status,
      input.preview,
      input.lastMessageAt,
      input.channelId,
      JSON.stringify(input.raw),
      now(),
    ],
  );
}

export async function listConversations(): Promise<ConversationRecord[]> {
  return many<ConversationRecord>(
    `SELECT conversations.id, conversations.contact_id, conversations.contact_name, conversations.contact_phone,
            conversations.status, conversations.preview, conversations.last_message_at, conversations.channel_id,
            conversations.updated_at, COALESCE(contacts.human_handoff, 0) AS human_handoff
     FROM conversations
     LEFT JOIN contacts ON contacts.id = conversations.contact_id
     ORDER BY conversations.last_message_at DESC`,
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
}): Promise<void> {
  await run(
    `INSERT INTO messages(id, conversation_id, direction, type, text, media_url, created_at, raw_json, origin)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       direction = excluded.direction,
       type = excluded.type,
       media_url = excluded.media_url,
       raw_json = excluded.raw_json,
       origin = CASE
         WHEN messages.origin IN ('manual', 'agent', 'scheduled') THEN messages.origin
         ELSE excluded.origin
       END`,
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
}

export async function listMessages(conversationId: string): Promise<MessageRecord[]> {
  return many<MessageRecord>(
    `SELECT id, conversation_id, direction, type, text, media_url, created_at, origin
     FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId],
  );
}

export async function recentMessages(conversationId: string, limit: number): Promise<MessageRecord[]> {
  const rows = await many<MessageRecord>(
    `SELECT id, conversation_id, direction, type, text, media_url, created_at, origin
     FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
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
  const conversations = await one<{ total: number }>('SELECT COUNT(*)::int AS total FROM conversations');
  const events = await one<{ total: number }>('SELECT COUNT(*)::int AS total FROM events');
  return {
    contacts: contacts?.total ?? 0,
    conversations: conversations?.total ?? 0,
    events: events?.total ?? 0,
  };
}
