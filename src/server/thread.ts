import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { upsertMessage } from './store.js';

const now = () => new Date().toISOString();

export async function findConversationId(contactId: string, phone: string): Promise<string> {
  const found = await one<{ id: string }>(
    `SELECT id FROM conversations
     WHERE contact_id = $1 OR ($2 <> '' AND contact_phone = $2)
     ORDER BY last_message_at DESC
     LIMIT 1`,
    [contactId, phone],
  );
  return found?.id || '';
}

export async function ensureConversation(input: {
  contactId: string;
  name: string;
  phone: string;
  channelId?: string;
}): Promise<string> {
  const existing = await findConversationId(input.contactId, input.phone);
  if (existing) return existing;
  const id = `local-${input.contactId}`;
  const timestamp = now();
  await run(
    `INSERT INTO conversations(
       id, contact_id, contact_name, contact_phone, status, preview, last_message_at, channel_id, raw_json, updated_at
     ) VALUES($1, $2, $3, $4, 'local', '', $5, $6, '{}', $5)
     ON CONFLICT(id) DO NOTHING`,
    [id, input.contactId, input.name, input.phone, timestamp, input.channelId || ''],
  );
  return id;
}

export async function attachLocalThread(realId: string, contactId: string): Promise<void> {
  const localId = `local-${contactId}`;
  if (!contactId || localId === realId) return;
  await run('UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2', [realId, localId]);
  await run('DELETE FROM conversations WHERE id = $1', [localId]);
}

export async function recordOutbound(input: {
  conversationId: string;
  text: string;
  origin: 'manual' | 'agent' | 'scheduled';
  raw?: unknown;
}): Promise<void> {
  const timestamp = now();
  await upsertMessage({
    id: randomUUID(),
    conversationId: input.conversationId,
    direction: 'OUTBOUND',
    type: 'text',
    text: input.text,
    createdAt: timestamp,
    origin: input.origin,
    raw: input.raw || { source: input.origin },
  });
  await run('UPDATE conversations SET preview = $1, last_message_at = $2, updated_at = $2 WHERE id = $3', [
    input.text.slice(0, 180),
    timestamp,
    input.conversationId,
  ]);
}

export async function saveSyncedMessage(input: {
  conversationId: string;
  id: string;
  direction: string;
  type: string;
  text: string;
  createdAt: string;
  raw: unknown;
}): Promise<{ id: string; direction: 'INBOUND' | 'OUTBOUND'; text: string; createdAt: string } | null> {
  const direction = input.direction.toUpperCase() === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND';
  if (direction === 'OUTBOUND' && input.text.trim()) {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const recent = await many<{ id: string; text: string }>(
      `SELECT id, text FROM messages
       WHERE conversation_id = $1 AND direction = 'OUTBOUND'
         AND origin IN ('manual', 'agent', 'scheduled') AND created_at >= $2`,
      [input.conversationId, since],
    );
    const incoming = input.text.trim();
    const twin = recent.find((item) => {
      const saved = item.text.trim();
      return saved === incoming || incoming.startsWith(saved) || saved.startsWith(incoming);
    });
    if (twin) {
      await run('UPDATE messages SET raw_json = $2 WHERE id = $1', [twin.id, JSON.stringify(input.raw)]);
      return null;
    }
  }
  await upsertMessage({
    id: input.id,
    conversationId: input.conversationId,
    direction,
    type: input.type,
    text: input.text,
    createdAt: input.createdAt,
    origin: direction === 'INBOUND' ? 'contact' : 'whatsapp',
    raw: input.raw,
  });
  return { id: input.id, direction, text: input.text, createdAt: input.createdAt };
}
