import { getSetting, many, one } from './db.js';
import { describeLinesAnswer } from './forms-bot-capture.js';
import { FORMS_BOT_LINES_FIELD, FORMS_BOT_LINES_MORE_FIELD } from './forms-bot-fields.js';
import { enqueueOutbound } from './outbound-outbox.js';
import {
  getCycleContextsByIds,
  markCycleCompleted,
  missingQuestions,
  upsertAnswers,
  type CycleAnswer,
} from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';
import { insertEvent } from './store.js';

/** Minutos sem movimento até encerrar sozinho (0 desliga). */
export const IDLE_CLOSE_SETTING = 'forms_bot_idle_close_minutes';
const DEFAULT_IDLE_MINUTES = 30;
/** Só ciclos com atividade recente: evita encerrar em massa ciclos antigos esquecidos. */
const MAX_LOOKBACK_HOURS = 24;
export const IDLE_CLOSE_ANSWER = 'não (encerrado por inatividade)';

export type IdleCloseResult = { closed: number; items: { cycleId: string; phone: string; detail: string }[] };

/** Falta só “Mais produtos?” — os dados obrigatórios (incl. linhas) já chegaram. */
export function isReadyForIdleClose(questions: QuestionnaireQuestion[], answers: CycleAnswer[]): boolean {
  const missing = missingQuestions(questions, answers);
  const hasLines = questions.some((item) => item.export_field === FORMS_BOT_LINES_FIELD);
  return hasLines && missing.length === 1 && missing[0].export_field === FORMS_BOT_LINES_MORE_FIELD;
}

/** “Fornecedor Teste Vertice; 100 kg de manga; 20 kg de mandioca”. */
export function idleCloseSummary(questions: QuestionnaireQuestion[], answers: CycleAnswer[]): string {
  return questions
    .filter((item) => item.export_field !== FORMS_BOT_LINES_MORE_FIELD)
    .map((item) => answers.find((row) => row.question_id === item.id)?.answer_text || '')
    .filter((text) => text.trim())
    .map((text) => describeLinesAnswer(text))
    .join('; ');
}

export function idleCloseMessage(contactName: string, summary: string): string {
  const name = contactName.trim().split(/\s+/)[0] || '';
  return [
    `${name ? `${name}, como` : 'Como'} não recebi mais itens, encerrei o registro: ${summary}.`,
    'Se faltou algo, é só me mandar que eu atualizo.',
  ].join('\n');
}

export function idleCloseMinutes(): number {
  const raw = Number(getSetting(IDLE_CLOSE_SETTING, String(DEFAULT_IDLE_MINUTES)));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Encerra ciclos do Forms Bot em que o contato mandou os dados mas não respondeu
 * “Mais produtos?” e a conversa ficou parada. Roda dentro do lock do agendador.
 */
export async function closeIdleFormsCycles(nowMs = Date.now()): Promise<IdleCloseResult> {
  const result: IdleCloseResult = { closed: 0, items: [] };
  const minutes = idleCloseMinutes();
  if (!minutes) return result;
  const cutoff = new Date(nowMs - minutes * 60_000).toISOString();
  const oldest = new Date(nowMs - MAX_LOOKBACK_HOURS * 3_600_000).toISOString();

  const candidates = await many<{ id: string; contact_id: string; phone: string; name: string }>(
    `SELECT cyc.id, cyc.contact_id, ct.phone, ct.name
     FROM questionnaire_cycles cyc
     JOIN contacts ct ON ct.id = cyc.contact_id
     WHERE cyc.questionnaire_id LIKE 'forms-preset:%'
       AND cyc.superseded_at = ''
       AND cyc.status IN ('notified', 'in_progress')
       AND NULLIF(cyc.last_inbound_at, '')::timestamptz BETWEEN $2::timestamptz AND $1::timestamptz
       AND COALESCE(NULLIF(cyc.last_prompted_at, ''), NULLIF(cyc.last_inbound_at, ''))::timestamptz <= $1::timestamptz
       AND ct.bot_enabled = 1 AND ct.blocked = 0 AND ct.hidden = 0
       AND COALESCE(ct.human_handoff, 0) = 0 AND ct.phone <> ''`,
    [cutoff, oldest],
  );

  for (const candidate of candidates) {
    // Mensagem do contato depois do corte (mesmo sem virar resposta): conversa ainda viva.
    const recent = await one<{ id: string }>(
      `SELECT m.id FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.contact_id = $1 AND m.direction = 'INBOUND' AND m.created_at::timestamptz > $2::timestamptz
       LIMIT 1`,
      [candidate.contact_id, cutoff],
    );
    if (recent) continue;

    const [context] = await getCycleContextsByIds([candidate.id]);
    if (!context || !isReadyForIdleClose(context.questionnaire.questions, context.answers)) continue;
    const moreQuestion = context.missing[0];
    const summary = idleCloseSummary(context.questionnaire.questions, context.answers);

    await upsertAnswers(candidate.id, [{ questionId: moreQuestion.id, text: IDLE_CLOSE_ANSWER, type: 'text' }]);
    await markCycleCompleted(candidate.id);

    const text = idleCloseMessage(candidate.name || '', summary);
    await enqueueOutbound({
      dedupeKey: `forms-bot:${candidate.id}:idle-close`,
      kind: 'text',
      phone: candidate.phone,
      text,
      channelId: getSetting('nevoa_channel_id'),
      contactId: candidate.contact_id,
      cycleId: candidate.id,
      origin: 'agent',
      raw: { source: 'forms-bot-idle-close', cycleId: candidate.id, idleMinutes: minutes },
    });
    await insertEvent({
      id: `forms-idle-close:${candidate.id}`,
      event: 'questionnaire.auto_close',
      status: 'reply',
      summary: `encerrado por inatividade (${minutes} min)`,
      payload: { cycleId: candidate.id, contactId: candidate.contact_id },
      result: { action: 'reply', source: 'fallback', text, mode: 'questionnaire', cycleId: candidate.id },
    });
    result.closed += 1;
    result.items.push({ cycleId: candidate.id, phone: candidate.phone, detail: summary });
  }
  return result;
}
