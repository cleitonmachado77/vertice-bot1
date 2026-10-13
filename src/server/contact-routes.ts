import { json, route, type Ctx } from './http.js';
import { hasSession } from './auth.js';
import { getContact, hideContact, upsertConversation, type ContactRecord } from './store.js';
import { createLocalContact, moveContact } from './local-contact.js';
import { ensureConversation, findConversationId, recordOutbound } from './thread.js';
import { getSetting } from './db.js';
import { asList } from './map.js';
import { NevoaError, listTemplates, sendWhatsappTemplate, sendWhatsappText } from './nevoa.js';
import { updateContactBasics } from './plans.js';

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

function templateItems(payload: unknown): { id: string; name: string; body: string; language: string; status: string }[] {
  return asList(payload)
    .map((row) => ({
      id: String(row.id || ''),
      name: String(row.name || row.externalTemplateName || 'Template'),
      body: String(row.body || ''),
      language: String(row.language || ''),
      status: String(row.status || ''),
    }))
    .filter((item) => item.id);
}

function variablesFor(body: string, name: string): string[] {
  const marks = body.match(/\{\{\s*\d+\s*\}\}/g) || [];
  const count = new Set(marks.map((mark) => mark.replace(/\D/g, ''))).size;
  return Array.from({ length: count }, () => name);
}

export function registerContactRoutes(): void {
  route('GET', '/api/templates', async (ctx) => {
    if (!requireUser(ctx)) return;
    const payload = await listTemplates(getSetting('nevoa_channel_id'));
    const all = templateItems(payload);
    json(ctx.res, 200, {
      items: all.filter((item) => item.status === 'APPROVED'),
      pending: all
        .filter((item) => item.status !== 'APPROVED')
        .map((item) => ({ name: item.name, status: item.status })),
    });
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
      json(ctx.res, 200, { contact });
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
    json(ctx.res, 200, {
      contact,
      conversationId: await findConversationId(contact.id, contact.phone),
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
    const channelId = getSetting('nevoa_channel_id');
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
  });

  route('POST', '/api/contacts/:id/start', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const contact = await getContact(ctx.params.id);
      if (!isVisible(contact) || !contact.phone) {
        json(ctx.res, 404, { error: 'Contato não encontrado' });
        return;
      }
      const channelId = getSetting('nevoa_channel_id');
      const templates = templateItems(await listTemplates(channelId)).filter((item) => item.status === 'APPROVED');
      const requested = text(body(ctx).templateId);
      const template = templates.find((item) => item.id === requested) || templates[0];
      if (!template) {
        json(ctx.res, 400, {
          error: 'Nenhum template ativo na Névoa. Aprove um modelo no WhatsApp para iniciar números novos.',
        });
        return;
      }
      const sent = (await sendWhatsappTemplate({
        templateId: template.id,
        phone: contact.phone,
        variables: variablesFor(template.body, contact.name || contact.phone),
        channelIntegrationId: channelId,
      })) as {
        conversation?: { id?: string; status?: string };
        contact?: { id?: string; name?: string; phone?: string };
      };
      const remoteId = String(sent.contact?.id || '');
      if (remoteId) await moveContact(contact.id, remoteId);
      const contactId = remoteId || contact.id;
      const conversationId =
        String(sent.conversation?.id || '') ||
        (await ensureConversation({
          contactId,
          name: contact.name,
          phone: contact.phone,
          channelId,
        }));
      const preview = template.body.replace(/\{\{\s*1\s*\}\}/g, contact.name || contact.phone) || template.name;
      await upsertConversation({
        id: conversationId,
        contactId,
        contactName: contact.name,
        contactPhone: contact.phone,
        status: String(sent.conversation?.status || 'TEMPLATE_OPEN'),
        preview,
        lastMessageAt: new Date().toISOString(),
        channelId,
        raw: sent,
      });
      await recordOutbound({ conversationId, text: preview, origin: 'manual', raw: sent });
      json(ctx.res, 200, { ok: true, conversationId, contactId });
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
