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

/** Janela de atendimento WhatsApp (~24h após última mensagem do contato). */
export async function hasOpenCustomerWindow(contactId: string, phone: string): Promise<boolean> {
  const lastInbound = await one<{ created_at: string }>(
    `SELECT m.created_at
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.direction = 'INBOUND'
       AND (c.contact_id = $1 OR ($2 <> '' AND c.contact_phone = $2))
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [contactId, phone],
  );
  if (!lastInbound?.created_at) return false;
  const at = Date.parse(lastInbound.created_at);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < 24 * 60 * 60 * 1000;
}

export async function hasOutboundMessage(contactId: string, phone: string): Promise<boolean> {
  const found = await one<{ id: string }>(
    `SELECT m.id
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.direction = 'OUTBOUND'
       AND (c.contact_id = $1 OR ($2 <> '' AND c.contact_phone = $2))
     LIMIT 1`,
    [contactId, phone],
  );
  return Boolean(found?.id);
}

/** Fora da janela 24h o WhatsApp só aceita template Meta. */
export async function getSessionGate(
  contactId: string,
  phone: string,
): Promise<{
  open: boolean;
  requiresTemplate: boolean;
  firstContact: boolean;
  message: string;
}> {
  const open = await hasOpenCustomerWindow(contactId, phone);
  if (open) {
    return {
      open: true,
      requiresTemplate: false,
      firstContact: false,
      message: '',
    };
  }
  const hasOutbound = await hasOutboundMessage(contactId, phone);
  return {
    open: false,
    requiresTemplate: true,
    firstContact: !hasOutbound,
    message: hasOutbound
      ? 'Janela de 24h fechada. Envie um template Meta para retomar a conversa. Mensagens livres ficam bloqueadas até o contato responder.'
      : 'Primeiro contato: a primeira mensagem precisa ser um template Meta aprovado. Mensagens livres ficam bloqueadas até o envio do template.',
  };
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

/** Outbound com o mesmo texto nos últimos 30 min (webhook de envio × registro local). */
async function findRecentOutboundTwin(
  conversationId: string,
  text: string,
  origins: string[] = ['whatsapp'],
): Promise<{ id: string } | undefined> {
  const incoming = String(text || '').trim();
  if (!conversationId || !incoming) return undefined;
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const recent = await many<{ id: string; text: string }>(
    `SELECT id, text FROM messages
     WHERE conversation_id = $1 AND direction = 'OUTBOUND'
       AND origin = ANY($2::text[]) AND created_at >= $3
     ORDER BY created_at DESC`,
    [conversationId, origins, since],
  );
  return recent.find((item) => {
    const saved = item.text.trim();
    return saved === incoming || incoming.startsWith(saved) || saved.startsWith(incoming);
  });
}

export async function recordOutbound(input: {
  conversationId: string;
  text: string;
  origin: 'manual' | 'agent' | 'scheduled';
  raw?: unknown;
}): Promise<void> {
  const timestamp = now();
  // O webhook de “mensagem enviada” pode chegar ANTES deste registro: se já existe
  // a mesma outbound recém-sincronizada, só marca a origem (evita duplicar o histórico).
  const twin = await findRecentOutboundTwin(input.conversationId, input.text);
  if (twin) {
    await run('UPDATE messages SET origin = $2, raw_json = $3 WHERE id = $1', [
      twin.id,
      input.origin,
      JSON.stringify(input.raw || { source: input.origin }),
    ]);
  } else {
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
  }
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
  mediaUrl?: string;
  createdAt: string;
  raw: unknown;
}): Promise<{
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  text: string;
  type: string;
  mediaUrl: string;
  createdAt: string;
} | null> {
  const direction = input.direction.toUpperCase() === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND';
  if (direction === 'OUTBOUND' && input.text.trim()) {
    const twin = await findRecentOutboundTwin(input.conversationId, input.text, [
      'manual',
      'agent',
      'scheduled',
    ]);
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
    mediaUrl: input.mediaUrl || '',
    createdAt: input.createdAt,
    origin: direction === 'INBOUND' ? 'contact' : 'whatsapp',
    raw: input.raw,
  });
  return {
    id: input.id,
    direction,
    text: input.text,
    type: input.type,
    mediaUrl: input.mediaUrl || '',
    createdAt: input.createdAt,
  };
}
