import { getSetting, one } from './db.js';
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
  markCycleNotified,
  missingQuestions,
  recoverStuckSendingCycles,
  rememberCyclePrompt,
  type CycleAnswer,
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

  const { botMenuSettings } = await import('./bot-menu.js');
  const { isFormsBotQuestionnaire } = await import('./forms-bot-agenda.js');
  const menuMode = botMenuSettings().enabled;
  const menuBatches = new Map<string, MenuBatch>();

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
      // Menu ligado: os formulários do contato viram uma única mensagem com o menu (enviada após o laço).
      if (menuMode && isFormsBotQuestionnaire(questionnaire)) {
        const batch = menuBatches.get(item.contact_id) || {
          item,
          templateId: questionnaire.template_id || '',
          cycles: [],
        };
        batch.cycles.push({ id: cycle.id, name: item.questionnaire_name });
        menuBatches.set(item.contact_id, batch);
        continue;
      }

      const alreadyStarted = savedAnswers.length > 0;
      const windowOpen = await hasOpenCustomerWindow(item.contact_id, item.phone);
      // Com respostas parciais, só pede o que falta (texto). Template completo atrapalharia.
      const preferSessionText = windowOpen || alreadyStarted;

      if (preferSessionText) {
        const text = await sessionKickoffText(
          questionnaire,
          item.name || item.phone,
          alreadyStarted ? { missing, answers: savedAnswers } : undefined,
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
        await rememberCyclePrompt(
          cycle.id,
          (alreadyStarted ? missing : questionnaire.questions)[0]?.id || '',
          'disparo agendado: texto',
        );
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
      await rememberCyclePrompt(cycle.id, questionnaire.questions[0]?.id || '', 'disparo agendado: template');
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

  for (const batch of menuBatches.values()) {
    await sendMenuBatch(batch, { channelId, date: clock.date, minutes: clock.minutes, ensureTemplate, templateErrors, result });
  }

  return result;
}

type MenuBatch = {
  item: { contact_id: string; name: string; phone: string };
  templateId: string;
  cycles: { id: string; name: string }[];
};

/** Conversa ativa agora há pouco: o menu agendado não interrompe; os pendentes aparecem no próximo menu. */
const MENU_BUSY_MINUTES = 10;

async function sendMenuBatch(
  batch: MenuBatch,
  ctx: {
    channelId: string;
    date: string;
    minutes: number;
    ensureTemplate: (configuredId: string) => Promise<FirstContactTemplate | undefined>;
    templateErrors: Map<string, string>;
    result: QuestionnaireDispatchRun;
  },
): Promise<void> {
  const { item, cycles } = batch;
  const { result } = ctx;
  const names = cycles.map((cycle) => cycle.name).join(', ');
  try {
    if (await hasOpenCustomerWindow(item.contact_id, item.phone)) {
      for (const cycle of cycles) await markCycleNotified(cycle.id);
      if (await hasRecentInbound(item.contact_id, MENU_BUSY_MINUTES)) {
        result.skipped += 1;
        result.items.push({
          phone: item.phone,
          status: 'skipped',
          detail: `${names} (conversa em andamento → pendente no menu)`,
        });
        return;
      }
      const { buildMenuKickoff } = await import('./bot-menu.js');
      const conversationId = await latestConversationId(item.contact_id);
      const text = await buildMenuKickoff({
        contactId: item.contact_id,
        contactName: item.name || '',
        conversationId,
        date: ctx.date,
        minutes: ctx.minutes,
      });
      if (!text) {
        result.skipped += 1;
        result.items.push({ phone: item.phone, status: 'skipped', detail: `${names} (menu vazio)` });
        return;
      }
      await enqueueOutbound({
        dedupeKey: `bot-menu:${cycles[0].id}:kickoff`,
        kind: 'text',
        phone: item.phone,
        text,
        channelId: ctx.channelId,
        conversationId,
        contactId: item.contact_id,
        origin: 'scheduled',
        raw: { source: 'bot-menu-kickoff', cycleIds: cycles.map((cycle) => cycle.id) },
      });
      result.sent += 1;
      result.items.push({ phone: item.phone, status: 'queued', detail: `${names} (janela aberta → menu)` });
      return;
    }

    const resolved = await ctx.ensureTemplate(batch.templateId);
    if (!resolved) {
      const templateError = ctx.templateErrors.get(batch.templateId) || 'Template indisponível';
      for (const cycle of cycles) await markCycleFailed(cycle.id, templateError);
      result.failed += 1;
      result.items.push({ phone: item.phone, status: 'failed', detail: templateError });
      return;
    }
    // Um template só; a resposta do contato abre o menu (sessão nova).
    const [first, ...rest] = cycles;
    for (const cycle of rest) await markCycleNotified(cycle.id);
    await enqueueOutbound({
      dedupeKey: `questionnaire:${first.id}:kickoff`,
      kind: 'template',
      variables: variablesFor(resolved.body, item.name || item.phone),
      templateId: resolved.id,
      phone: item.phone,
      text: resolved.body.replace(/\{\{\s*1\s*\}\}/g, item.name || item.phone) || resolved.name,
      channelId: ctx.channelId,
      contactId: item.contact_id,
      cycleId: first.id,
      origin: 'scheduled',
      raw: { source: 'bot-menu-template', cycleIds: cycles.map((cycle) => cycle.id) },
    });
    result.sent += 1;
    result.items.push({ phone: item.phone, status: 'queued', detail: `${names} (janela fechada → template, menu na resposta)` });
  } catch (error) {
    const detail = error instanceof NevoaError ? error.message : 'Falha ao enviar menu';
    for (const cycle of cycles) await markCycleFailed(cycle.id, detail);
    result.failed += 1;
    result.items.push({ phone: item.phone, status: 'failed', detail });
  }
}

async function hasRecentInbound(contactId: string, minutes: number): Promise<boolean> {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const row = await one<{ id: string }>(
    `SELECT m.id FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.contact_id = $1 AND m.direction = 'INBOUND' AND m.created_at > $2
     LIMIT 1`,
    [contactId, since],
  );
  return Boolean(row);
}

async function latestConversationId(contactId: string): Promise<string> {
  const row = await one<{ id: string }>(
    `SELECT id FROM conversations WHERE contact_id = $1 ORDER BY last_message_at DESC LIMIT 1`,
    [contactId],
  );
  return row?.id || '';
}

/** Forms Bot: convite guiado (lista numerada do catálogo), igual ao “Enviar agora”. */
async function sessionKickoffText(
  questionnaire: Questionnaire,
  name: string,
  remaining?: { missing: QuestionnaireQuestion[]; answers: CycleAnswer[] },
): Promise<string> {
  const { isFormsBotQuestionnaire } = await import('./forms-bot-agenda.js');
  if (!isFormsBotQuestionnaire(questionnaire)) {
    return buildSessionKickoffText(questionnaire, name, remaining?.missing);
  }
  if (remaining?.missing.length) {
    const { missingPromptFor } = await import('./forms-bot-capture.js');
    const prompt = await missingPromptFor(questionnaire, remaining.missing, remaining.answers);
    return [`Oi ${name}! Recebi o que você já mandou. Ainda falta:`, '', prompt].join('\n');
  }
  const { buildFormsBotGuidedInvite } = await import('./forms-bot-catalog-context.js');
  const greeting = greetingFor(questionnaire, name) || QUESTIONNAIRE_FIRST_CONTACT_PHRASE.replace(/\{\{\s*1\s*\}\}/g, name);
  return buildFormsBotGuidedInvite({ greeting, questionnaire });
}

function greetingFor(questionnaire: Questionnaire, name: string): string {
  return (questionnaire.greeting || '')
    .replace(/\{\{\s*1\s*\}\}/g, name)
    .replace(/\{\{nome\}\}/gi, name)
    .trim();
}

function buildSessionKickoffText(
  questionnaire: Questionnaire,
  name: string,
  onlyQuestions?: QuestionnaireQuestion[],
): string {
  const greeting = greetingFor(questionnaire, name);
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
