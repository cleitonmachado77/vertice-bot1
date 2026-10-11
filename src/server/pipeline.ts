import { randomUUID } from 'node:crypto';
import { getSetting } from './db.js';
import { mapContact, mapConversation, inboundContent, unwrapEnvelope } from './map.js';
import { zonedNow } from './clock.js';
import { attachCollectedResponse } from './plans.js';
import {
  getContact,
  hasEvent,
  insertEvent,
  upsertContact,
  upsertConversation,
  upsertMessage,
} from './store.js';
import { answerInbound } from './reply.js';
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

  return {
    pending: true,
    id,
    event,
    data,
    conversationId,
    phone,
    channelId,
    text: content.prompt,
    messageId: String((messageRaw.id as string) || `${id}:in`),
    contact,
  } as unknown as Decision;
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
  messageId: string;
  contact: { id: string; name: string } | null;
};

export function isPending(value: Decision | Pending): value is Pending {
  return Boolean((value as Pending).pending);
}

export async function completeInbound(pending: Pending): Promise<Decision> {
  const answer = await answerInbound({
    messageId: pending.messageId,
    conversationId: pending.conversationId,
    text: pending.text,
    phone: pending.phone,
    channelId: pending.channelId,
    contactId: pending.contact?.id,
    contactName: pending.contact?.name,
  });
  if (!answer.sent) {
    return await finish(
      pending.id,
      pending.event,
      ignore(pending.id, pending.event, answer.detail, pending.conversationId, pending.phone, pending.channelId),
      pending.data,
    );
  }
  const decision: Decision = {
    ok: true,
    action: 'reply',
    reason: answer.detail,
    conversationId: pending.conversationId,
    phone: answer.phone,
    channelIntegrationId: answer.channelId,
    text: answer.text,
    source: answer.source,
    nevoa: null,
  };
  return await finish(pending.id, pending.event, decision, pending.data, false);
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

async function finish(
  id: string,
  event: string,
  decision: Decision,
  payload: unknown,
  record = true,
): Promise<Decision> {
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
  if (record && decision.action === 'reply' && decision.conversationId && decision.text) {
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
