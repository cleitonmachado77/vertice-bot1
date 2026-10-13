import { getSetting } from './db.js';
import { minutesFromClock, zonedNow } from './clock.js';
import { asList } from './map.js';
import { moveContact } from './local-contact.js';
import { NevoaError, listTemplates, sendWhatsappTemplate, sendWhatsappText } from './nevoa.js';
import {
  claimCycleForSend,
  listCycleAnswers,
  listDueQuestionnaireSends,
  markCycleCompleted,
  markCycleFailed,
  markCycleNotified,
  missingQuestions,
  recoverStuckSendingCycles,
} from './questionnaire-cycles.js';
import {
  QUESTIONNAIRE_FIRST_CONTACT_PHRASE,
  getQuestionnaire,
  type Questionnaire,
  type QuestionnaireQuestion,
} from './questionnaires.js';
import { ensureConversation, hasOpenCustomerWindow, recordOutbound } from './thread.js';
import { upsertConversation } from './store.js';

export type QuestionnaireDispatchRun = {
  date: string;
  sent: number;
  failed: number;
  waiting: number;
  skipped: number;
  items: { phone: string; status: string; detail: string }[];
};

type FirstContactTemplate = { id: string; name: string; body: string };

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
  const recovered = await recoverStuckSendingCycles(10);
  if (recovered) {
    result.items.push({
      phone: '-',
      status: 'recovered',
      detail: `${recovered} ciclo(s) travado(s) liberado(s)`,
    });
  }

  const channelId = getSetting('nevoa_channel_id');
  if (!channelId) {
    result.failed += 1;
    result.items.push({ phone: '-', status: 'failed', detail: 'nevoa_channel_id não configurado' });
    return result;
  }

  let template: FirstContactTemplate | undefined;
  let templateError = '';
  const ensureTemplate = async (): Promise<FirstContactTemplate | undefined> => {
    if (template) return template;
    if (templateError) return undefined;
    try {
      template = await resolveFirstContactTemplate(channelId);
      if (!template) templateError = 'Nenhum template Meta APPROVED disponível para o primeiro envio';
    } catch (error) {
      templateError = error instanceof Error ? error.message : 'Falha ao listar templates';
    }
    return template;
  };

  const due = await listDueQuestionnaireSends(clock.weekday);
  if (!due.length) {
    result.skipped += 1;
    result.items.push({
      phone: '-',
      status: 'skipped',
      detail: 'Nenhum questionário ativo com contato atribuído para hoje',
    });
  }

  const questionnaireCache = new Map<string, Questionnaire | undefined>();

  for (const item of due) {
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
      let questionnaire = questionnaireCache.get(item.questionnaire_id);
      if (!questionnaireCache.has(item.questionnaire_id)) {
        questionnaire = await getQuestionnaire(item.questionnaire_id);
        questionnaireCache.set(item.questionnaire_id, questionnaire);
      }
      if (!questionnaire?.questions.length) {
        await markCycleFailed(cycle.id, 'Questionário sem perguntas');
        result.failed += 1;
        result.items.push({ phone: item.phone, status: 'failed', detail: 'Questionário sem perguntas' });
        continue;
      }

      // Contato já respondeu antes do disparo: não reenvia o questionário inteiro.
      const savedAnswers = await listCycleAnswers(cycle.id);
      const missing = missingQuestions(questionnaire.questions, savedAnswers);
      if (!missing.length) {
        await markCycleCompleted(cycle.id);
        result.skipped += 1;
        result.items.push({
          phone: item.phone,
          status: 'skipped',
          detail: `${item.questionnaire_name} (já respondido antes do disparo)`,
        });
        continue;
      }
      const alreadyStarted = savedAnswers.length > 0;
      const windowOpen = await hasOpenCustomerWindow(item.contact_id, item.phone);
      // Com respostas parciais, só pede o que falta (texto). Template completo atrapalharia.
      const preferSessionText = windowOpen || alreadyStarted;
      let sessionTextFailed = false;

      if (preferSessionText) {
        const text = buildSessionKickoffText(
          questionnaire,
          item.name || item.phone,
          alreadyStarted ? missing : undefined,
        );
        try {
          const sent = (await sendWhatsappText({
            phone: item.phone,
            text,
            channelIntegrationId: channelId,
          })) as {
            conversation?: { id?: string; status?: string };
            contact?: { id?: string };
          };
          await finalizeOutbound({
            sent,
            item,
            channelId,
            cycleId: cycle.id,
            preview: text,
            originRaw: {
              source: alreadyStarted ? 'questionnaire-session-remaining' : 'questionnaire-session',
              questionnaireId: item.questionnaire_id,
              cycleId: cycle.id,
            },
            conversationStatus: String(sent.conversation?.status || 'OPEN'),
          });
          result.sent += 1;
          result.items.push({
            phone: item.phone,
            status: 'notified',
            detail: alreadyStarted
              ? `${item.questionnaire_name} (já tinha respostas → só faltantes)`
              : `${item.questionnaire_name} (janela aberta → texto)`,
          });
          continue;
        } catch (error) {
          sessionTextFailed = true;
          const detail = error instanceof NevoaError ? error.message : 'Falha ao enviar texto na janela';
          console.warn(`questionário: texto falhou (${item.phone}): ${detail}`);
          if (alreadyStarted) {
            // Já engajou: marca notificado sem template para o agente continuar na próxima mensagem.
            await markCycleNotified(cycle.id);
            result.skipped += 1;
            result.items.push({
              phone: item.phone,
              status: 'skipped',
              detail: `${item.questionnaire_name} (respostas parciais; texto falhou, sem reenviar template)`,
            });
            continue;
          }
        }
      }

      const resolved = await ensureTemplate();
      if (!resolved) {
        await markCycleFailed(cycle.id, templateError || 'Template indisponível');
        result.failed += 1;
        result.items.push({
          phone: item.phone,
          status: 'failed',
          detail: templateError || 'Template indisponível',
        });
        continue;
      }

      const variables = variablesFor(resolved.body, item.name || item.phone);
      const sent = (await sendWhatsappTemplate({
        templateId: resolved.id,
        phone: item.phone,
        variables,
        channelIntegrationId: channelId,
      })) as {
        conversation?: { id?: string; status?: string };
        contact?: { id?: string };
      };
      const preview =
        resolved.body.replace(/\{\{\s*1\s*\}\}/g, item.name || item.phone) ||
        item.greeting ||
        resolved.name;

      await finalizeOutbound({
        sent,
        item,
        channelId,
        cycleId: cycle.id,
        preview,
        originRaw: { source: 'questionnaire-template', questionnaireId: item.questionnaire_id, cycleId: cycle.id },
        conversationStatus: String(sent.conversation?.status || 'TEMPLATE_OPEN'),
      });
      result.sent += 1;
      const mode = sessionTextFailed
        ? 'texto falhou → template'
        : 'janela fechada → template';
      result.items.push({
        phone: item.phone,
        status: 'notified',
        detail: `${item.questionnaire_name} (${mode})`,
      });
    } catch (error) {
      const detail = error instanceof NevoaError ? error.message : 'Falha ao enviar questionário';
      await markCycleFailed(cycle.id, detail);
      result.failed += 1;
      result.items.push({ phone: item.phone, status: 'failed', detail });
    }
  }

  return result;
}

async function finalizeOutbound(input: {
  sent: { conversation?: { id?: string; status?: string }; contact?: { id?: string } };
  item: { contact_id: string; name: string; phone: string };
  channelId: string;
  cycleId: string;
  preview: string;
  originRaw: unknown;
  conversationStatus: string;
}): Promise<void> {
  const remoteId = String(input.sent.contact?.id || '');
  if (remoteId && remoteId !== input.item.contact_id) {
    await moveContact(input.item.contact_id, remoteId);
  }
  const contactId = remoteId || input.item.contact_id;
  const conversationId =
    String(input.sent.conversation?.id || '') ||
    (await ensureConversation({
      contactId,
      name: input.item.name,
      phone: input.item.phone,
      channelId: input.channelId,
    }));

  await upsertConversation({
    id: conversationId,
    contactId,
    contactName: input.item.name,
    contactPhone: input.item.phone,
    status: input.conversationStatus,
    preview: input.preview,
    lastMessageAt: new Date().toISOString(),
    channelId: input.channelId,
    raw: input.sent,
  });
  await recordOutbound({
    conversationId,
    text: input.preview,
    origin: 'scheduled',
    raw: input.originRaw,
  });
  await markCycleNotified(input.cycleId);
}

function buildSessionKickoffText(
  questionnaire: Questionnaire,
  name: string,
  onlyQuestions?: QuestionnaireQuestion[],
): string {
  const greeting = (questionnaire.greeting || '')
    .replace(/\{\{\s*1\s*\}\}/g, name)
    .replace(/\{\{nome\}\}/gi, name)
    .trim();
  const questions = onlyQuestions?.length ? onlyQuestions : questionnaire.questions;
  const remaining = Boolean(onlyQuestions?.length);
  const lines = questions.map((question, index) => `${index + 1}) ${question.body.trim()}`);
  const defaultIntro = QUESTIONNAIRE_FIRST_CONTACT_PHRASE.replace(/\{\{\s*1\s*\}\}/g, name);
  const intro = remaining
    ? `Oi ${name}! Recebi o que você já mandou. Ainda faltam:`
    : greeting || defaultIntro;
  return [intro, '', ...lines, '', 'Pode responder por texto, áudio, imagem ou vídeo.'].join('\n').trim();
}

async function resolveFirstContactTemplate(channelId: string): Promise<FirstContactTemplate | undefined> {
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
  if (configured) {
    const selected = templates.find((item) => item.id === configured);
    if (selected) return selected;
  }
  const ranked = [...templates].sort((a, b) => scoreTemplate(b) - scoreTemplate(a));
  return ranked[0];
}

function scoreTemplate(template: { name: string; body: string }): number {
  const hay = `${template.name} ${template.body}`.toLowerCase();
  if (hay.includes('questionário') || hay.includes('questionario')) return 100;
  if (hay.includes('acompanhamento')) return 80;
  if (hay.includes('pendente') || hay.includes('continuidade')) return 0;
  if (hay.includes('início') || hay.includes('inicio') || hay.includes('conversa')) return 20;
  return 10;
}

function variablesFor(body: string, name: string): string[] {
  const marks = body.match(/\{\{\s*\d+\s*\}\}/g) || [];
  const count = new Set(marks.map((mark) => mark.replace(/\D/g, ''))).size;
  return Array.from({ length: count }, () => name);
}
