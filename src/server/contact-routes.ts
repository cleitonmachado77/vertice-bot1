import { json, route, type Ctx } from './http.js';
import { hasSession } from './auth.js';
import { getContact, hideContact, type ContactRecord } from './store.js';
import { createLocalContact } from './local-contact.js';
import { getSetting } from './db.js';
import { asList } from './map.js';
import { NevoaError, listTemplates, sendWhatsappText } from './nevoa.js';
import { updateContactBasics } from './plans.js';
import {
  listApprovedTemplates,
  resolveFirstContactTemplate,
  sendFirstContactTemplate,
} from './first-contact.js';
import { ensureConversation, findConversationId, getSessionGate, recordOutbound } from './thread.js';

function isVisible(contact: ContactRecord | undefined): contact is ContactRecord {
  return Boolean(contact) && Number(contact?.hidden) !== 1;
}

function requireUser(ctx: Ctx): boolean {
  if (hasSession(ctx.req.headers.cookie)) return true;
  json(ctx.res, 401, { error: 'Faça login' });
  return false;
}

function body(ctx: Ctx): Record<string, unknown> {
  return ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, unknown>) : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function fail(ctx: Ctx, error: unknown): void {
  if (error instanceof NevoaError) {
    json(ctx.res, error.status, { error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'Erro interno';
  json(ctx.res, 400, { error: message });
}

function phoneE164(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+') && digits.length >= 10) return `+${digits}`;
  if (digits.startsWith('55') && digits.length >= 12) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  throw new Error('Informe o telefone com DDI, por exemplo +5543999999999');
}

export function registerContactRoutes(): void {
  route('GET', '/api/templates', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const all = asList(await listTemplates(getSetting('nevoa_channel_id'))).map((row) => ({
        id: String(row.id || ''),
        name: String(row.name || row.externalTemplateName || 'Template'),
        body: String(row.body || ''),
        language: String(row.language || ''),
        status: String(row.status || ''),
      }));
      const items = all.filter((item) => item.id && item.status === 'APPROVED');
      const selected = resolveFirstContactTemplate(items);
      json(ctx.res, 200, {
        items,
        selectedId: selected?.id || getSetting('first_contact_template_id') || '',
        pending: all
          .filter((item) => item.id && item.status !== 'APPROVED')
          .map((item) => ({ name: item.name, status: item.status })),
      });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/contacts', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const input = body(ctx);
      const contact = await createLocalContact({
        name: text(input.name).trim() || 'Sem nome',
        phone: phoneE164(text(input.phone)),
        email: text(input.email).trim(),
      });
      json(ctx.res, 200, {
        contact,
        conversationId: await findConversationId(contact.id, contact.phone),
      });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/contacts/:id', async (ctx) => {
    if (!requireUser(ctx)) return;
    const contact = await getContact(ctx.params.id);
    if (!isVisible(contact)) {
      json(ctx.res, 404, { error: 'Contato não encontrado' });
      return;
    }
    await hideContact(contact.id, contact.phone);
    json(ctx.res, 200, { ok: true });
  });

  route('GET', '/api/contacts/:id', async (ctx) => {
    if (!requireUser(ctx)) return;
    const contact = await getContact(ctx.params.id);
    if (!isVisible(contact)) {
      json(ctx.res, 404, { error: 'Contato não encontrado' });
      return;
    }
    const conversationId =
      (await findConversationId(contact.id, contact.phone)) ||
      (await ensureConversation({
        contactId: contact.id,
        name: contact.name,
        phone: contact.phone,
        channelId: getSetting('nevoa_channel_id'),
      }));
    const gate = await getSessionGate(contact.id, contact.phone);
    const templates = gate.requiresTemplate ? await listApprovedTemplates().catch(() => []) : [];
    json(ctx.res, 200, {
      contact,
      conversationId,
      session: gate,
      templates,
      defaultTemplateId: resolveFirstContactTemplate(templates)?.id || '',
    });
  });

  route('POST', '/api/contacts/:id/send', async (ctx) => {
    if (!requireUser(ctx)) return;
    const contact = await getContact(ctx.params.id);
    const message = text(body(ctx).text).trim();
    if (!isVisible(contact)) {
      json(ctx.res, 404, { error: 'Contato não encontrado' });
      return;
    }
    if (!contact.phone || !message) {
      json(ctx.res, 400, { error: 'Mensagem ou telefone ausente' });
      return;
    }
    const gate = await getSessionGate(contact.id, contact.phone);
    if (gate.requiresTemplate) {
      json(ctx.res, 409, { error: gate.message || 'Envie um template Meta antes de mensagens livres.' });
      return;
    }
    const channelId = getSetting('nevoa_channel_id');
    try {
      const sent = await sendWhatsappText({
        phone: contact.phone,
        text: message,
        channelIntegrationId: channelId,
      });
      const conversationId = await ensureConversation({
        contactId: contact.id,
        name: contact.name,
        phone: contact.phone,
        channelId,
      });
      await recordOutbound({ conversationId, text: message, origin: 'manual', raw: sent });
      json(ctx.res, 200, { ok: true, conversationId });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/contacts/:id/start', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const result = await sendFirstContactTemplate({
        contactId: ctx.params.id,
        templateId: text(body(ctx).templateId),
      });
      json(ctx.res, 200, {
        ok: true,
        conversationId: result.conversationId,
        contactId: result.contactId,
      });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('PUT', '/api/contacts/:id', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const current = await getContact(ctx.params.id);
      if (!isVisible(current)) {
        json(ctx.res, 404, { error: 'Contato não encontrado' });
        return;
      }
      const input = body(ctx);
      await updateContactBasics(ctx.params.id, {
        name: text(input.name).trim(),
        phone: phoneE164(text(input.phone)),
        email: text(input.email).trim(),
        botEnabled: input.botEnabled !== false,
      });
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });
}
