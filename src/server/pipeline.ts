import { randomUUID } from 'node:crypto';
import { getSetting } from './db.js';
import { mapContact, mapConversation, inboundContent, unwrapEnvelope } from './map.js';
import { draftReply } from './agent.js';
import { zonedNow } from './clock.js';
import { attachCollectedResponse } from './plans.js';
import {
  getContact,
  hasEvent,
  insertEvent,
  recentMessages,
  upsertContact,
  upsertConversation,
  upsertMessage,
} from './store.js';
import { recordOutbound } from './thread.js';

export type Decision = {
  ok: true;
  action: 'reply' | 'ignore';
  reason: string;
  conversationId: string;
  phone: string;
  channelIntegrationId: string;
  text: string;
  source: string;
  nevoa: {
    method: 'POST';
    path: '/messages';
    body: {
      phone: string;
      type: 'TEXT';
      text: string;
      channelIntegrationId?: string;
    };
  } | null;
};

export async function processInbound(raw: unknown, deliveryId = ''): Promise<Decision> {
  const envelope = unwrapEnvelope(raw);
  const event = String(envelope.event || 'unknown');
  const id = String(envelope.id || deliveryId || randomUUID());
  if (await hasEvent(id)) {
    return ignore(id, event, 'Evento duplicado', '', '', '');
  }

  const data = (envelope.data || {}) as Record<string, unknown>;
  const contactRaw = (data.contact || {}) as Record<string, unknown>;
  const conversationRaw = (data.conversation || {}) as Record<string, unknown>;
  const messageRaw = (data.message || data) as Record<string, unknown>;
  const contact = contactRaw.id ? mapContact(contactRaw) : null;
  const conversationId = String(
    conversationRaw.id || data.conversationId || conversationRaw.conversation_id || '',
  );
  const phone = contact?.phone || String(contactRaw.primaryPhoneE164 || contactRaw.phone || '');
  const channel = (data.channel || {}) as Record<string, unknown>;
  const channelId = String(channel.integrationId || getSetting('nevoa_channel_id') || '');
  const content = inboundContent(messageRaw);

  if (contact?.id) {
    await upsertContact({ ...contact, raw: contactRaw });
  }
  if (conversationId) {
    const mapped = mapConversation({
      ...conversationRaw,
      id: conversationId,
      contact: contactRaw,
      channel,
      last_message: conversationRaw.lastMessage || data.last_message,
    });
    await upsertConversation({
      ...mapped,
      id: conversationId,
      contactId: contact?.id || mapped.contactId,
      contactName: contact?.name || mapped.contactName,
      contactPhone: phone || mapped.contactPhone,
      channelId: channelId || mapped.channelId,
      preview: content.prompt || mapped.preview,
      raw: data,
    });
  }

  if (event === 'message.received' && conversationId) {
    await upsertMessage({
      id: String((messageRaw.id as string) || `${id}:in`),
      conversationId,
      direction: 'INBOUND',
      type: content.kind,
      text: content.text || content.prompt,
      mediaUrl: content.mediaUrl,
      createdAt: String(envelope.occurredAt || new Date().toISOString()),
      origin: 'contact',
      raw: messageRaw,
    });
  }
  if (event === 'message.received' && contact?.id) {
    await attachCollectedResponse(contact.id, zonedNow().date, {
      type: content.kind,
      text: content.text || content.prompt,
      mediaUrl: content.mediaUrl,
    });
  }

  if (event !== 'message.received') {
    return await finish(id, event, ignore(id, event, 'Evento registrado', conversationId, phone, channelId), data);
  }

  const local = contact?.id ? await getContact(contact.id) : undefined;
  if (local && !local.bot_enabled) {
    return await finish(id, event, ignore(id, event, 'Bot pausado neste contato', conversationId, phone, channelId), data);
  }
  if (local?.human_handoff) {
    return await finish(id, event, ignore(id, event, 'Humano assumiu a conversa', conversationId, phone, channelId), data);
  }
  if (content.prompt.includes('Unsupported message')) {
    return await finish(id, event, ignore(id, event, 'Mensagem não suportada pelo WhatsApp', conversationId, phone, channelId), data);
  }

  return { pending: true, id, event, data, conversationId, phone, channelId, text: content.prompt, contact } as unknown as Decision;
}

type Pending = {
  pending: true;
  id: string;
  event: string;
  data: unknown;
  conversationId: string;
  phone: string;
  channelId: string;
  text: string;
  contact: { id: string; name: string } | null;
};

export function isPending(value: Decision | Pending): value is Pending {
  return Boolean((value as Pending).pending);
}

export async function completeInbound(pending: Pending): Promise<Decision> {
  const limit = Number(getSetting('agent_history') || '8');
  const history = (pending.conversationId ? await recentMessages(pending.conversationId, limit) : []).filter(
    (item, index, all) => !(index === all.length - 1 && item.direction === 'INBOUND' && item.text === pending.text),
  );
  const local = pending.contact?.id ? await getContact(pending.contact.id) : undefined;
  const draft = await draftReply({
    contactName: local?.name || pending.contact?.name || '',
    contactPhone: pending.phone,
    notes: local?.notes || '',
    instructions: local?.instructions || '',
    prompt: local?.prompt || '',
    history: history.map((item) => ({ direction: item.direction, text: item.text })),
    inbound: pending.text,
    hasText: Boolean(pending.text.trim()),
    allowReply: true,
  });

  if (!draft.text || !pending.phone) {
    const reason = draft.detail || (pending.phone ? 'Sem resposta' : 'Contato sem telefone');
    return await finish(
      pending.id,
      pending.event,
      ignore(pending.id, pending.event, reason, pending.conversationId, pending.phone, pending.channelId),
      pending.data,
    );
  }

  const decision: Decision = {
    ok: true,
    action: 'reply',
    reason: draft.detail,
    conversationId: pending.conversationId,
    phone: pending.phone,
    channelIntegrationId: pending.channelId,
    text: draft.text,
    source: draft.source,
    nevoa: {
      method: 'POST',
      path: '/messages',
      body: {
        phone: pending.phone,
        type: 'TEXT',
        text: draft.text,
        ...(pending.channelId ? { channelIntegrationId: pending.channelId } : {}),
      },
    },
  };
  return await finish(pending.id, pending.event, decision, pending.data);
}

function ignore(
  id: string,
  event: string,
  reason: string,
  conversationId: string,
  phone: string,
  channelId: string,
): Decision {
  return {
    ok: true,
    action: 'ignore',
    reason,
    conversationId,
    phone,
    channelIntegrationId: channelId,
    text: '',
    source: 'none',
    nevoa: null,
  };
}

async function finish(id: string, event: string, decision: Decision, payload: unknown): Promise<Decision> {
  if (!(await hasEvent(id))) {
    await insertEvent({
      id,
      event,
      status: decision.action,
      summary: decision.reason,
      payload,
      result: { action: decision.action, source: decision.source, text: decision.text },
    });
  }
  if (decision.action === 'reply' && decision.conversationId && decision.text) {
    await recordOutbound({
      conversationId: decision.conversationId,
      text: decision.text,
      origin: 'agent',
      raw: { source: decision.source },
    });
  }
  return decision;
}

export async function handleInbound(raw: unknown, deliveryId = ''): Promise<Decision> {
  const first = await processInbound(raw, deliveryId);
  if (isPending(first)) return completeInbound(first);
  return first;
}
