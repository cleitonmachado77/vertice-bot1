import { getSetting } from './db.js';
import { asList } from './map.js';
import { listTemplates, sendWhatsappTemplate } from './nevoa.js';
import { moveContact } from './local-contact.js';
import { ensureConversation, recordOutbound } from './thread.js';
import { getContact, upsertConversation } from './store.js';

export type ApprovedTemplate = { id: string; name: string; body: string; language: string };

export async function listApprovedTemplates(channelId = getSetting('nevoa_channel_id')): Promise<ApprovedTemplate[]> {
  if (!channelId) return [];
  return asList(await listTemplates(channelId))
    .map((row) => ({
      id: String(row.id || ''),
      name: String(row.name || row.externalTemplateName || 'Template'),
      body: String(row.body || ''),
      language: String(row.language || ''),
      status: String(row.status || ''),
    }))
    .filter((item) => item.id && item.status === 'APPROVED')
    .map(({ id, name, body, language }) => ({ id, name, body, language }));
}

export function resolveFirstContactTemplate(
  templates: ApprovedTemplate[],
  requestedId = '',
): ApprovedTemplate | undefined {
  if (!templates.length) return undefined;
  const configured = getSetting('first_contact_template_id') || getSetting('questionnaire_template_id');
  return (
    templates.find((item) => item.id === requestedId) ||
    templates.find((item) => item.id === configured) ||
    templates.find((item) => /primeiro.?contato.?atendimento|primeiro_contato_atendimento/i.test(item.name)) ||
    templates.find((item) => /in[ií]cio|primeiro|boas.?vindas|relacionamento/i.test(item.name)) ||
    templates[0]
  );
}

export function variablesForTemplate(body: string, name: string): string[] {
  const marks = body.match(/\{\{\s*\d+\s*\}\}/g) || [];
  const count = new Set(marks.map((mark) => mark.replace(/\D/g, ''))).size;
  return Array.from({ length: count }, () => name);
}

export async function sendFirstContactTemplate(input: {
  contactId: string;
  templateId?: string;
}): Promise<{ conversationId: string; contactId: string; preview: string; template: ApprovedTemplate }> {
  const contact = await getContact(input.contactId);
  if (!contact || Number(contact.hidden) === 1 || !contact.phone) {
    throw new Error('Contato não encontrado');
  }
  const channelId = getSetting('nevoa_channel_id');
  if (!channelId) throw new Error('nevoa_channel_id não configurado');
  const templates = await listApprovedTemplates(channelId);
  const template = resolveFirstContactTemplate(templates, input.templateId || '');
  if (!template) {
    throw new Error('Nenhum template ativo na Névoa. Aprove um modelo no WhatsApp para iniciar números novos.');
  }

  const sent = (await sendWhatsappTemplate({
    templateId: template.id,
    phone: contact.phone,
    variables: variablesForTemplate(template.body, contact.name || contact.phone),
    channelIntegrationId: channelId,
  })) as {
    conversation?: { id?: string; status?: string };
    contact?: { id?: string };
  };

  const remoteId = String(sent.contact?.id || '');
  if (remoteId && remoteId !== contact.id) await moveContact(contact.id, remoteId);
  const contactId = remoteId || contact.id;
  const conversationId =
    String(sent.conversation?.id || '') ||
    (await ensureConversation({
      contactId,
      name: contact.name,
      phone: contact.phone,
      channelId,
    }));
  const preview =
    template.body.replace(/\{\{\s*1\s*\}\}/g, contact.name || contact.phone) || template.name;

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
  await recordOutbound({
    conversationId,
    text: preview,
    origin: 'manual',
    raw: { source: 'first-contact-template', templateId: template.id, nevoa: sent },
  });

  return { conversationId, contactId, preview, template };
}
