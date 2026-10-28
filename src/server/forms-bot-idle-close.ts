import { zonedNow } from './clock.js';
import { getSetting, many, one } from './db.js';
import { missingPromptFor } from './forms-bot-capture.js';
import { formsAnswersSummary } from './forms-bot-closing.js';
import { FORMS_BOT_CONFIRM_FIELD, FORMS_BOT_LINES_MORE_FIELD, isMarkedNewValue } from './forms-bot-fields.js';
import { effectiveIdleRules, isQuietTime, parseFormsBotRules, type EffectiveIdleRules } from './forms-bot-rules.js';
import { enqueueOutbound } from './outbound-outbox.js';
import {
  getCycleContextsByIds,
  markCycleCompleted,
  missingQuestions,
  rememberCyclePrompt,
  upsertAnswers,
  type ActiveCycleContext,
  type CycleAnswer,
} from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';
import { hasEvent, insertEvent } from './store.js';

/** Só ciclos com atividade recente: evita mexer em massa em ciclos antigos esquecidos. */
const MAX_LOOKBACK_HOURS = 24;
export const IDLE_CLOSE_ANSWER = 'não (encerrado por inatividade)';
export const IDLE_CONFIRM_ANSWER = 'sim (encerrado por inatividade)';
const CLOSING_FIELDS = new Set([FORMS_BOT_LINES_MORE_FIELD, FORMS_BOT_CONFIRM_FIELD]);

export type IdleAction = 'none' | 'remind-more' | 'close' | 'remind-missing' | 'alert-stalled';
export type IdleRunResult = { closed: number; reminded: number; alerted: number; items: { cycleId: string; phone: string; detail: string }[] };

/** Falta só o fechamento (“Mais produtos?” e/ou confirmação): os dados obrigatórios já chegaram. */
export function isReadyForIdleClose(questions: QuestionnaireQuestion[], answers: CycleAnswer[]): boolean {
  // Valor “[novo?]” aguardando o contato: encerrar sobrescreveria os itens novos com “não”.
  if (answers.some((row) => isMarkedNewValue(row.answer_text))) return false;
  const missing = missingQuestions(questions, answers);
  return missing.length > 0 && missing.every((item) => CLOSING_FIELDS.has(String(item.export_field || '').trim()));
}

/** O que fazer com um ciclo parado nesta rodada do agendador. */
export function decideIdleAction(input: {
  ready: boolean;
  idleMinutes: number;
  rules: EffectiveIdleRules;
  /** Minutos desde o lembrete desta fase (null = ainda não enviado). */
  reminderAgeMinutes: number | null;
  stalledAlerted: boolean;
  quiet: boolean;
}): IdleAction {
  const { reminderMinutes: remind, closeMinutes: close, stalledAlertMinutes: stalled } = input.rules;
  if (input.ready) {
    if (input.quiet) return 'none';
    const useReminder = remind > 0 && (close === 0 || remind < close);
    if (useReminder && input.reminderAgeMinutes == null) return input.idleMinutes >= remind ? 'remind-more' : 'none';
    if (close === 0) return 'none';
    if (useReminder) {
      // Dá ao contato o tempo prometido no lembrete (“encerro em N minutos”).
      return input.idleMinutes >= close && (input.reminderAgeMinutes ?? 0) >= close - remind ? 'close' : 'none';
    }
    return input.idleMinutes >= close ? 'close' : 'none';
  }
  if (!input.quiet && remind > 0 && input.reminderAgeMinutes == null && input.idleMinutes >= remind) {
    return 'remind-missing';
  }
  // Alerta só no painel: vale também no horário de silêncio.
  if (!input.stalledAlerted && stalled > 0 && input.idleMinutes >= stalled) return 'alert-stalled';
  return 'none';
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || '';
}

export function idleCloseMessage(contactName: string, summary: string): string {
  const name = firstName(contactName);
  return [
    `${name ? `${name}, como` : 'Como'} não recebi mais itens, encerrei o registro: ${summary}.`,
    'Se faltou algo, é só me mandar que eu atualizo.',
  ].join('\n');
}

export function idleReminderMessage(input: {
  contactName: string;
  summary: string;
  onlyConfirm: boolean;
  closeInMinutes: number;
}): string {
  const name = firstName(input.contactName);
  const lead = name ? `${name}, ` : '';
  const when = input.closeInMinutes > 0 ? ` Se eu não tiver resposta, registro em ${input.closeInMinutes} minutos.` : '';
  return input.onlyConfirm
    ? `${lead}posso registrar? ${input.summary}.${when}`
    : `${lead}mais algum produto? Se não, é só responder “não”.${when}`;
}

/**
 * Ciclos do Forms Bot parados: lembra, encerra quando só falta o fechamento,
 * lembra o que falta e avisa no painel quando ficam travados. Roda dentro do lock do agendador.
 */
export async function runFormsBotIdleRules(nowMs = Date.now()): Promise<IdleRunResult> {
  const result: IdleRunResult = { closed: 0, reminded: 0, alerted: 0, items: [] };
  const oldest = new Date(nowMs - MAX_LOOKBACK_HOURS * 3_600_000).toISOString();
  const quiet = isQuietTime(zonedNow().minutes);
  const candidates = await many<{
    id: string;
    contact_id: string;
    phone: string;
    name: string;
    rules_json: string;
    last_activity: Date | string;
  }>(
    `SELECT cyc.id, cyc.contact_id, ct.phone, ct.name, COALESCE(p.bot_rules_json, '{}') AS rules_json,
            GREATEST(
              NULLIF(cyc.last_inbound_at, '')::timestamptz,
              (SELECT MAX(m.created_at::timestamptz) FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
               WHERE c.contact_id = cyc.contact_id AND m.direction = 'INBOUND')
            ) AS last_activity
     FROM questionnaire_cycles cyc
     JOIN contacts ct ON ct.id = cyc.contact_id
     LEFT JOIN forms_presets p ON 'forms-preset:' || p.id = cyc.questionnaire_id
     WHERE cyc.questionnaire_id LIKE 'forms-preset:%'
       AND cyc.superseded_at = ''
       AND cyc.status IN ('notified', 'in_progress')
       AND NULLIF(cyc.last_inbound_at, '')::timestamptz >= $1::timestamptz
       AND ct.bot_enabled = 1 AND ct.blocked = 0 AND ct.hidden = 0
       AND COALESCE(ct.human_handoff, 0) = 0 AND ct.phone <> ''
       AND NOT EXISTS (
         SELECT 1 FROM outbound_outbox o
         WHERE o.cycle_id = cyc.id AND o.status IN ('pending', 'retry', 'sending')
       )`,
    [oldest],
  );

  for (const candidate of candidates) {
    const [context] = await getCycleContextsByIds([candidate.id]);
    if (!context) continue;
    const ready = isReadyForIdleClose(context.questionnaire.questions, context.answers);
    const reminderKey = `forms-bot:${candidate.id}:${ready ? 'idle-reminder' : 'missing-reminder'}`;
    const reminder = await one<{ created_at: Date | string }>(
      `SELECT created_at FROM outbound_outbox WHERE dedupe_key = $1`,
      [reminderKey],
    );
    const minutesSince = (value: Date | string) => (nowMs - new Date(value).getTime()) / 60_000;
    const rules = effectiveIdleRules(parseFormsBotRules(candidate.rules_json));
    const action = decideIdleAction({
      ready,
      idleMinutes: minutesSince(candidate.last_activity),
      rules,
      reminderAgeMinutes: reminder ? minutesSince(reminder.created_at) : null,
      stalledAlerted: await hasEvent(`forms-stalled:${candidate.id}`),
      quiet,
    });
    if (action === 'none') continue;

    const summary = formsAnswersSummary(context.questionnaire.questions, context.answers);
    const detail = await applyIdleAction({ action, candidate, context, summary, rules, reminderKey });
    if (action === 'close') result.closed += 1;
    else if (action === 'alert-stalled') result.alerted += 1;
    else result.reminded += 1;
    result.items.push({ cycleId: candidate.id, phone: candidate.phone, detail });
  }
  return result;
}

async function applyIdleAction(input: {
  action: Exclude<IdleAction, 'none'>;
  candidate: { id: string; contact_id: string; phone: string; name: string };
  context: ActiveCycleContext;
  summary: string;
  rules: EffectiveIdleRules;
  reminderKey: string;
}): Promise<string> {
  const { action, candidate, context } = input;
  const send = async (dedupeKey: string, text: string, source: string) =>
    enqueueOutbound({
      dedupeKey,
      kind: 'text',
      phone: candidate.phone,
      text,
      channelId: getSetting('nevoa_channel_id'),
      contactId: candidate.contact_id,
      cycleId: candidate.id,
      origin: 'agent',
      raw: { source, cycleId: candidate.id },
    });
  const log = (id: string, summary: string, text: string) =>
    insertEvent({
      id,
      event: 'questionnaire.idle',
      status: action === 'alert-stalled' ? 'alert' : 'reply',
      summary,
      payload: { cycleId: candidate.id, contactId: candidate.contact_id },
      result: { action, source: 'fallback', text, mode: 'questionnaire', cycleId: candidate.id },
    });

  if (action === 'close') {
    const fill = context.missing.map((item) => ({
      questionId: item.id,
      text: String(item.export_field || '').trim() === FORMS_BOT_CONFIRM_FIELD ? IDLE_CONFIRM_ANSWER : IDLE_CLOSE_ANSWER,
      type: 'text',
    }));
    await upsertAnswers(candidate.id, fill);
    await markCycleCompleted(candidate.id);
    const text = idleCloseMessage(candidate.name || '', input.summary);
    await send(`forms-bot:${candidate.id}:idle-close`, text, 'forms-bot-idle-close');
    await log(`forms-idle-close:${candidate.id}`, `encerrado por inatividade (${input.rules.closeMinutes} min)`, text);
    return `encerrado por inatividade: ${input.summary}`;
  }

  if (action === 'remind-more') {
    const onlyConfirm = context.missing.every((item) => String(item.export_field || '').trim() === FORMS_BOT_CONFIRM_FIELD);
    const { reminderMinutes, closeMinutes } = input.rules;
    const text = idleReminderMessage({
      contactName: candidate.name || '',
      summary: input.summary,
      onlyConfirm,
      closeInMinutes: closeMinutes > 0 ? closeMinutes - reminderMinutes : 0,
    });
    await send(input.reminderKey, text, 'forms-bot-idle-reminder');
    await rememberCyclePrompt(candidate.id, context.missing[0]?.id || '', 'inatividade: lembrete de fechamento');
    await log(`forms-idle-reminder:${candidate.id}`, 'lembrete antes de encerrar', text);
    return 'lembrete antes de encerrar';
  }

  if (action === 'remind-missing') {
    const prompt = await missingPromptFor(context.questionnaire, context.missing, context.answers);
    const name = firstName(candidate.name || '');
    const text = [`${name ? `${name}, ainda` : 'Ainda'} falta para concluir o registro:`, prompt].join('\n\n');
    await send(input.reminderKey, text, 'forms-bot-missing-reminder');
    await rememberCyclePrompt(candidate.id, context.missing[0]?.id || '', 'inatividade: lembrete do que falta');
    await log(`forms-missing-reminder:${candidate.id}`, 'lembrete do que falta', text);
    return 'lembrete do que falta';
  }

  const missingLabels = context.missing.map((item) => item.body).join('; ');
  const text = `Registro parado com dados faltando: ${missingLabels}. Já recebido: ${input.summary || 'nada'}.`;
  await log(`forms-stalled:${candidate.id}`, `parado sem concluir (${input.rules.stalledAlertMinutes} min)`, text);
  return 'alerta no painel: parado sem concluir';
}
