import { getSetting } from './db.js';
import { minutesFromClock, zonedNow } from './clock.js';
import { asList } from './map.js';
import { moveContact } from './local-contact.js';
import { NevoaError, listTemplates, sendWhatsappTemplate } from './nevoa.js';
import {
  claimCycleForSend,
  listDueQuestionnaireSends,
  markCycleFailed,
  markCycleNotified,
} from './questionnaire-cycles.js';
import { ensureConversation, recordOutbound } from './thread.js';
import { upsertConversation } from './store.js';

export type QuestionnaireDispatchRun = {
  date: string;
  sent: number;
  failed: number;
  waiting: number;
  skipped: number;
  items: { phone: string; status: string; detail: string }[];
};

export async function runQuestionnaireDispatches(): Promise<QuestionnaireDispatchRun> {
  const clock = zonedNow();
  const result: QuestionnaireDispatchRun = {
    date: clock.date,
    sent: 0,
    failed: 0,
    waiting: 0,
    skipped: 0,
    items: [],
  };
  const channelId = getSetting('nevoa_channel_id');
  let template: { id: string; name: string; body: string } | undefined;
  try {
    template = await resolveFirstContactTemplate(channelId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Falha ao listar templates';
    result.failed += 1;
    result.items.push({ phone: '-', status: 'failed', detail });
    return result;
  }
  if (!template) {
    result.skipped += 1;
    result.items.push({
      phone: '-',
      status: 'skipped',
      detail: 'Template de primeiro envio não configurado ou indisponível',
    });
    return result;
  }

  for (const item of await listDueQuestionnaireSends(clock.weekday)) {
    if (clock.minutes < minutesFromClock(item.send_time)) {
      result.waiting += 1;
      continue;
    }

    const cycle = await claimCycleForSend(item.questionnaire_id, item.contact_id, clock.date);
    if (!cycle) {
      result.skipped += 1;
      continue;
    }

    try {
      const variables = variablesFor(template.body, item.name || item.phone);
      const sent = (await sendWhatsappTemplate({
        templateId: template.id,
        phone: item.phone,
        variables,
        channelIntegrationId: channelId,
      })) as {
        conversation?: { id?: string; status?: string };
        contact?: { id?: string };
      };

      const remoteId = String(sent.contact?.id || '');
      if (remoteId && remoteId !== item.contact_id) {
        await moveContact(item.contact_id, remoteId);
      }
      const contactId = remoteId || item.contact_id;
      const conversationId =
        String(sent.conversation?.id || '') ||
        (await ensureConversation({
          contactId,
          name: item.name,
          phone: item.phone,
          channelId,
        }));
      const preview =
        template.body.replace(/\{\{\s*1\s*\}\}/g, item.name || item.phone) ||
        item.greeting ||
        template.name;

      await upsertConversation({
        id: conversationId,
        contactId,
        contactName: item.name,
        contactPhone: item.phone,
        status: String(sent.conversation?.status || 'TEMPLATE_OPEN'),
        preview,
        lastMessageAt: new Date().toISOString(),
        channelId,
        raw: sent,
      });
      await recordOutbound({
        conversationId,
        text: preview,
        origin: 'scheduled',
        raw: { source: 'questionnaire-template', questionnaireId: item.questionnaire_id, cycleId: cycle.id },
      });
      await markCycleNotified(cycle.id);
      result.sent += 1;
      result.items.push({ phone: item.phone, status: 'notified', detail: item.questionnaire_name });
    } catch (error) {
      const detail = error instanceof NevoaError ? error.message : 'Falha ao enviar template';
      await markCycleFailed(cycle.id, detail);
      result.failed += 1;
      result.items.push({ phone: item.phone, status: 'failed', detail });
    }
  }

  return result;
}

async function resolveFirstContactTemplate(channelId: string): Promise<
  { id: string; name: string; body: string } | undefined
> {
  const configured = getSetting('questionnaire_template_id');
  const templates = asList(await listTemplates(channelId))
    .map((row) => ({
      id: String(row.id || ''),
      name: String(row.name || row.externalTemplateName || 'Template'),
      body: String(row.body || ''),
      status: String(row.status || ''),
    }))
    .filter((item) => item.id && item.status === 'APPROVED');
  if (!templates.length) return undefined;
  return templates.find((item) => item.id === configured) || templates[0];
}

function variablesFor(body: string, name: string): string[] {
  const marks = body.match(/\{\{\s*\d+\s*\}\}/g) || [];
  const count = new Set(marks.map((mark) => mark.replace(/\D/g, ''))).size;
  return Array.from({ length: count }, () => name);
}
