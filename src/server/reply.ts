import { draftReply } from './agent.js';
import { getSetting, one } from './db.js';
import { sendWhatsappText } from './nevoa.js';
import { getContact, getConversation, hasEvent, insertEvent, recentMessages } from './store.js';
import { recordOutbound } from './thread.js';

const RECENT_MS = 30 * 60 * 1000;
const inflight = new Set<string>();

export type AgentAnswer = {
  sent: boolean;
  text: string;
  detail: string;
  phone: string;
  channelId: string;
  source: string;
};

export async function answerInbound(input: {
  messageId: string;
  conversationId: string;
  text: string;
  createdAt?: string;
  phone?: string;
  channelId?: string;
  contactId?: string;
  contactName?: string;
}): Promise<AgentAnswer> {
  const empty = (detail: string): AgentAnswer => ({
    sent: false,
    text: '',
    detail,
    phone: input.phone || '',
    channelId: input.channelId || '',
    source: 'none',
  });
  if (!input.messageId || !input.conversationId || !input.text.trim()) return empty('Mensagem sem conteúdo');
  if (input.text.includes('Unsupported message')) return empty('Mensagem não suportada pelo WhatsApp');
  if (input.createdAt && !isRecent(input.createdAt)) return empty('Mensagem antiga');
  const storedAt = await messageTime(input.messageId);
  const createdAt = storedAt || input.createdAt || '';
  if (createdAt && !isRecent(createdAt)) return empty('Mensagem antiga');

  const marker = `agent-reply:${input.messageId}`;
  if (inflight.has(marker)) return empty('Resposta já em andamento');
  inflight.add(marker);
  try {
    if (await hasEvent(marker)) return empty('Resposta já enviada');
    const followed = createdAt ? await hasLaterOutbound(input.conversationId, createdAt) : false;
    if (followed) return empty('Conversa já seguida');

    const conversation = await getConversation(input.conversationId);
    const contactId = input.contactId || conversation?.contact_id || '';
    const contact = contactId ? await getContact(contactId) : undefined;
    if (contact && !contact.bot_enabled) return empty('Bot pausado neste contato');
    if (contact?.human_handoff) return empty('Humano assumiu a conversa');

    const phone = input.phone || conversation?.contact_phone || contact?.phone || '';
    const channelId = input.channelId || conversation?.channel_id || getSetting('nevoa_channel_id');
    if (!phone) return empty('Contato sem telefone');

    const limit = Number(getSetting('agent_history') || '8');
    const history = (await recentMessages(input.conversationId, limit)).filter(
      (item, index, all) => !(index === all.length - 1 && item.direction === 'INBOUND' && item.text === input.text),
    );
    const draft = await draftReply({
      contactName: contact?.name || input.contactName || conversation?.contact_name || '',
      contactPhone: phone,
      notes: contact?.notes || '',
      instructions: contact?.instructions || '',
      prompt: contact?.prompt || '',
      history: history.map((item) => ({ direction: item.direction, text: item.text })),
      inbound: input.text,
      hasText: true,
      allowReply: true,
    });
    if (!draft.text) return empty(draft.detail || 'Sem resposta');

    await sendWhatsappText({
      phone,
      text: draft.text,
      ...(channelId ? { channelIntegrationId: channelId } : {}),
    });
    await recordOutbound({
      conversationId: input.conversationId,
      text: draft.text,
      origin: 'agent',
      raw: { source: draft.source, messageId: input.messageId },
    });
    await insertEvent({
      id: marker,
      event: 'message.received',
      status: 'reply',
      summary: draft.detail,
      payload: { messageId: input.messageId, conversationId: input.conversationId },
      result: { action: 'reply', source: draft.source, text: draft.text },
    });
    return { sent: true, text: draft.text, detail: draft.detail, phone, channelId, source: draft.source };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Falha ao responder';
    console.error(`resposta do agente: ${detail}`);
    return empty(detail);
  } finally {
    inflight.delete(marker);
  }
}

async function messageTime(messageId: string): Promise<string> {
  const row = await one<{ created_at: string }>('SELECT created_at FROM messages WHERE id = $1', [messageId]);
  return row?.created_at || '';
}

function isRecent(value: string): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && Date.now() - at <= RECENT_MS;
}

async function hasLaterOutbound(conversationId: string, createdAt: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `SELECT id FROM messages
     WHERE conversation_id = $1 AND direction = 'OUTBOUND' AND created_at > $2
     LIMIT 1`,
    [conversationId, createdAt],
  );
  return Boolean(row);
}
