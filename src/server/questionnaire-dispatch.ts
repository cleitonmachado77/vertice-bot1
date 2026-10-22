import { getSetting } from './db.js';
import { minutesFromClock, zonedNow } from './clock.js';
import { asList } from './map.js';
import { NevoaError, listTemplates } from './nevoa.js';
import { enqueueOutbound } from './outbound-outbox.js';
import {
  claimCycleForSend,
  getQuestionnaireForCycle,
  listCycleAnswers,
  listDueQuestionnaireSends,
  markCycleCompleted,
  markCycleFailed,
  missingQuestions,
  recoverStuckSendingCycles,
} from './questionnaire-cycles.js';
import {
  QUESTIONNAIRE_FIRST_CONTACT_PHRASE,
  type Questionnaire,
  type QuestionnaireQuestion,
} from './questionnaires.js';
import { hasOpenCustomerWindow } from './thread.js';

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

  const templateCache = new Map<string, FirstContactTemplate | undefined>();
  const templateErrors = new Map<string, string>();
  const ensureTemplate = async (configuredId: string): Promise<FirstContactTemplate | undefined> => {
    if (templateCache.has(configuredId)) return templateCache.get(configuredId);
    try {
      const template = await resolveFirstContactTemplate(channelId, configuredId);
      templateCache.set(configuredId, template);
      if (!template) {
        templateErrors.set(configuredId, 'Nenhum template Meta APPROVED disponível para o primeiro envio');
      }
      return template;
    } catch (error) {
      templateErrors.set(
        configuredId,
        error instanceof Error ? error.message : 'Falha ao listar templates',
      );
      templateCache.set(configuredId, undefined);
      return undefined;
    }
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
      const questionnaire = await getQuestionnaireForCycle(cycle);
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

      if (preferSessionText) {
        const text = buildSessionKickoffText(
          questionnaire,
          item.name || item.phone,
          alreadyStarted ? missing : undefined,
        );
        await enqueueOutbound({
          dedupeKey: `questionnaire:${cycle.id}:kickoff`,
          kind: 'text',
          phone: item.phone,
          text,
          channelId,
          contactId: item.contact_id,
          cycleId: cycle.id,
          origin: 'scheduled',
          raw: {
            source: alreadyStarted ? 'questionnaire-session-remaining' : 'questionnaire-session',
            questionnaireId: item.questionnaire_id,
            cycleId: cycle.id,
          },
        });
        result.sent += 1;
        result.items.push({
          phone: item.phone,
          status: 'queued',
          detail: alreadyStarted
            ? `${item.questionnaire_name} (já tinha respostas → só faltantes)`
            : `${item.questionnaire_name} (janela aberta → texto)`,
        });
        continue;
      }

      const resolved = await ensureTemplate(questionnaire.template_id || '');
      if (!resolved) {
        const templateError =
          templateErrors.get(questionnaire.template_id || '') || 'Template indisponível';
        await markCycleFailed(cycle.id, templateError);
        result.failed += 1;
        result.items.push({
          phone: item.phone,
          status: 'failed',
          detail: templateError,
        });
        continue;
      }

      const variables = variablesFor(resolved.body, item.name || item.phone);
      const preview =
        resolved.body.replace(/\{\{\s*1\s*\}\}/g, item.name || item.phone) ||
        questionnaire.greeting ||
        resolved.name;
      await enqueueOutbound({
        dedupeKey: `questionnaire:${cycle.id}:kickoff`,
        kind: 'template',
        variables,
        templateId: resolved.id,
        phone: item.phone,
        text: preview,
        channelId,
        contactId: item.contact_id,
        cycleId: cycle.id,
        origin: 'scheduled',
        raw: {
          source: 'questionnaire-template',
          questionnaireId: item.questionnaire_id,
          cycleId: cycle.id,
        },
      });
      result.sent += 1;
      result.items.push({
        phone: item.phone,
        status: 'queued',
        detail: `${item.questionnaire_name} (janela fechada → template)`,
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

export async function resolveFirstContactTemplate(
  channelId: string,
  questionnaireTemplateId = '',
): Promise<FirstContactTemplate | undefined> {
  const configured = questionnaireTemplateId || getSetting('questionnaire_template_id');
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

export function variablesFor(body: string, name: string): string[] {
  const marks = body.match(/\{\{\s*\d+\s*\}\}/g) || [];
  const count = new Set(marks.map((mark) => mark.replace(/\D/g, ''))).size;
  return Array.from({ length: count }, () => name);
}
