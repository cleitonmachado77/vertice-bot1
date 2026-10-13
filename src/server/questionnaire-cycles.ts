import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { runsOnWeekday } from './plans.js';
import {
  getQuestionnaire,
  getQuestionnaireRevision,
  type Questionnaire,
  type QuestionnaireQuestion,
} from './questionnaires.js';

const now = () => new Date().toISOString();

export type CycleStatus =
  | 'open'
  | 'sending'
  | 'notified'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'delivery_unknown';

export type QuestionnaireCycle = {
  id: string;
  questionnaire_id: string;
  contact_id: string;
  revision_id: string;
  occurrence_date: string;
  status: CycleStatus;
  template_sent_at: string;
  completed_at: string;
  error: string;
  updated_at?: string;
  last_prompted_at?: string;
  last_inbound_at?: string;
};

export type CycleAnswer = {
  id: string;
  cycle_id: string;
  question_id: string;
  answer_text: string;
  answer_type: string;
  media_url: string;
};

export type ActiveCycleContext = {
  cycle: QuestionnaireCycle;
  questionnaire: Questionnaire;
  answers: CycleAnswer[];
  missing: QuestionnaireQuestion[];
};

export type DueQuestionnaireSend = {
  questionnaire_id: string;
  questionnaire_name: string;
  greeting: string;
  contact_id: string;
  name: string;
  phone: string;
  send_time: string;
  frequency: string;
  weekday: number;
  template_id: string;
};

export type CollectedRow = {
  cycle_id: string;
  questionnaire_id: string;
  questionnaire_name: string;
  contact_id: string;
  contact_name: string;
  contact_phone: string;
  occurrence_date: string;
  cycle_status: string;
  question_id: string;
  question_body: string;
  answer_text: string;
  answer_type: string;
  media_url: string;
  answered_at: string;
};

export function toCycleContext(
  cycle: QuestionnaireCycle,
  questionnaire: Questionnaire,
  answers: CycleAnswer[],
): ActiveCycleContext {
  const answered = new Set(answers.map((row) => row.question_id));
  return {
    cycle,
    questionnaire,
    answers,
    missing: questionnaire.questions.filter((question) => !answered.has(question.id)),
  };
}

export async function setConversationCycleContext(
  conversationId: string,
  cycleId: string,
  awaitingEdit = false,
): Promise<void> {
  if (!conversationId) return;
  const contextMode = awaitingEdit ? 2 : 0;
  await run(
    `INSERT INTO conversation_questionnaire_context(
       conversation_id, active_cycle_id, candidate_cycle_ids_json, awaiting_selection, updated_at
     ) VALUES($1, $2, '[]', $3, $4)
     ON CONFLICT(conversation_id) DO UPDATE SET
       active_cycle_id = excluded.active_cycle_id, candidate_cycle_ids_json = '[]',
       awaiting_selection = CASE
         WHEN conversation_questionnaire_context.awaiting_selection = 2
           AND conversation_questionnaire_context.active_cycle_id = excluded.active_cycle_id
           AND excluded.awaiting_selection = 0
         THEN 2
         ELSE excluded.awaiting_selection
       END,
       updated_at = excluded.updated_at`,
    [conversationId, cycleId, contextMode, now()],
  );
}

export async function clearConversationCompletedEditContext(
  conversationId: string,
): Promise<void> {
  if (!conversationId) return;
  await run(
    `UPDATE conversation_questionnaire_context
     SET awaiting_selection = 0, updated_at = $2
     WHERE conversation_id = $1 AND awaiting_selection = 2`,
    [conversationId, now()],
  );
}

export async function setConversationCycleCandidates(
  conversationId: string,
  cycleIds: string[],
): Promise<void> {
  if (!conversationId || !cycleIds.length) return;
  await run(
    `INSERT INTO conversation_questionnaire_context(
       conversation_id, active_cycle_id, candidate_cycle_ids_json, awaiting_selection, updated_at
     ) VALUES($1, '', $2, 1, $3)
     ON CONFLICT(conversation_id) DO UPDATE SET
       active_cycle_id = '', candidate_cycle_ids_json = excluded.candidate_cycle_ids_json,
       awaiting_selection = 1, updated_at = excluded.updated_at`,
    [conversationId, JSON.stringify(cycleIds), now()],
  );
}

/** Ciclo concluído recente (hoje ou até 7 dias) — correções, complementos e exclusões. */
export async function findCompletedCycleForContact(
  contactId: string,
  date: string,
  _weekday?: number,
  questionnaireHint = '',
): Promise<ActiveCycleContext | undefined> {
  const candidates = await listCompletedCycleContexts(contactId, recentOccurrenceDates(date, 7));
  const named = candidates.filter((item) =>
    fold(questionnaireHint).includes(fold(item.questionnaire.name)),
  );
  if (named.length === 1) return named[0];
  return (
    candidates.find((item) => item.cycle.occurrence_date === date) ||
    candidates[0]
  );
}

export async function listCompletedCycleContexts(
  contactId: string,
  dates: string[],
): Promise<ActiveCycleContext[]> {
  const cycles = await many<QuestionnaireCycle>(
    `SELECT cyc.id, cyc.questionnaire_id, cyc.contact_id, cyc.revision_id,
            cyc.occurrence_date, cyc.status, cyc.template_sent_at, cyc.completed_at,
            cyc.error, cyc.updated_at, cyc.last_prompted_at, cyc.last_inbound_at
     FROM questionnaire_cycles cyc
     WHERE cyc.contact_id = $1
       AND cyc.status = 'completed'
       AND cyc.occurrence_date = ANY($2::text[])
     ORDER BY cyc.occurrence_date DESC, cyc.updated_at DESC NULLS LAST`,
    [contactId, dates],
  );
  return loadCycleContexts(cycles);
}

export async function getCycleContextsByIds(ids: string[]): Promise<ActiveCycleContext[]> {
  if (!ids.length) return [];
  const cycles = await many<QuestionnaireCycle>(
    `SELECT id, questionnaire_id, contact_id, revision_id, occurrence_date, status,
            template_sent_at, completed_at, error, updated_at, last_prompted_at, last_inbound_at
     FROM questionnaire_cycles WHERE id = ANY($1::text[])`,
    [ids],
  );
  const order = new Map(ids.map((id, index) => [id, index]));
  const contexts = await loadCycleContexts(cycles);
  return contexts.sort(
    (a, b) => (order.get(a.cycle.id) ?? 0) - (order.get(b.cycle.id) ?? 0),
  );
}

async function loadCycleContexts(cycles: QuestionnaireCycle[]): Promise<ActiveCycleContext[]> {
  const contexts: ActiveCycleContext[] = [];
  for (const cycle of cycles) {
    const questionnaire = await getQuestionnaireForCycle(cycle);
    if (!questionnaire?.questions.length) continue;
    contexts.push(
      toCycleContext(cycle, questionnaire, await listCycleAnswers(cycle.id)),
    );
  }
  return contexts;
}

export async function getQuestionnaireForCycle(
  cycle: QuestionnaireCycle,
): Promise<Questionnaire | undefined> {
  if (cycle.revision_id) {
    const revision = await getQuestionnaireRevision(cycle.revision_id);
    if (revision) return revision;
  }
  return getQuestionnaire(cycle.questionnaire_id);
}

function recentOccurrenceDates(today: string, days: number): string[] {
  const base = new Date(`${today}T12:00:00`);
  if (Number.isNaN(base.getTime())) return [today];
  const dates: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(base);
    day.setDate(base.getDate() - offset);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

function fold(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
}

export async function listDueQuestionnaireSends(weekday: number): Promise<DueQuestionnaireSend[]> {
  const rows = await many<DueQuestionnaireSend>(
    `SELECT q.id AS questionnaire_id, q.name AS questionnaire_name, q.greeting, q.send_time,
            q.frequency, q.weekday, q.template_id,
            c.id AS contact_id, c.name, c.phone
     FROM questionnaire_assignments a
     JOIN questionnaires q ON q.id = a.questionnaire_id
     JOIN contacts c ON c.id = a.contact_id
     WHERE q.active = 1 AND q.deleted_at = ''
       AND c.bot_enabled = 1 AND c.blocked = 0 AND c.hidden = 0 AND c.phone <> ''
     ORDER BY q.send_time, q.name, c.name`,
  );
  return rows.filter((row) => runsOnWeekday(row, weekday));
}

export async function getOrCreateCycle(
  questionnaireId: string,
  contactId: string,
  date: string,
): Promise<QuestionnaireCycle> {
  const existing = await one<QuestionnaireCycle>(
    `SELECT id, questionnaire_id, contact_id, revision_id, occurrence_date, status,
            template_sent_at, completed_at, error, updated_at, last_prompted_at, last_inbound_at
     FROM questionnaire_cycles
     WHERE questionnaire_id = $1 AND contact_id = $2 AND occurrence_date = $3`,
    [questionnaireId, contactId, date],
  );
  if (existing) return existing;

  const stamp = now();
  const id = randomUUID();
  const revision = await one<{ id: string }>(
    `SELECT id FROM questionnaire_revisions
     WHERE questionnaire_id = $1 ORDER BY version DESC LIMIT 1`,
    [questionnaireId],
  );
  if (!revision) throw new Error('Questionário sem versão disponível');
  try {
    await run(
      `INSERT INTO questionnaire_cycles(
         id, questionnaire_id, contact_id, revision_id, occurrence_date, status,
         template_sent_at, completed_at, error, created_at, updated_at, last_prompted_at, last_inbound_at
       ) VALUES($1, $2, $3, $4, $5, 'open', '', '', '', $6, $6, '', '')`,
      [id, questionnaireId, contactId, revision.id, date, stamp],
    );
  } catch {
    // Concorrência: outro processo criou o ciclo do dia.
  }
  const created = await one<QuestionnaireCycle>(
    `SELECT id, questionnaire_id, contact_id, revision_id, occurrence_date, status,
            template_sent_at, completed_at, error, updated_at, last_prompted_at, last_inbound_at
     FROM questionnaire_cycles
     WHERE questionnaire_id = $1 AND contact_id = $2 AND occurrence_date = $3`,
    [questionnaireId, contactId, date],
  );
  if (!created) throw new Error('Falha ao abrir ciclo do questionário');
  return created;
}

/** Libera ciclos travados em "sending" após queda do processo. */
export async function recoverStuckSendingCycles(maxAgeMinutes = 10): Promise<number> {
  const stamp = now();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const rows = await many<{ id: string }>(
    `UPDATE questionnaire_cycles
     SET status = 'failed', error = 'Envio interrompido; será tentado de novo', updated_at = $1
     WHERE status = 'sending' AND updated_at < $2
       AND NOT EXISTS (
         SELECT 1 FROM outbound_outbox outbox
         WHERE outbox.cycle_id = questionnaire_cycles.id
           AND outbox.status IN ('pending', 'retry', 'sending', 'uncertain')
       )
     RETURNING id`,
    [stamp, cutoff],
  );
  return rows.length;
}

/** Reserva o ciclo para envio do template; retorna null se já foi notificado/concluído ou outro worker pegou. */
export async function claimCycleForSend(
  questionnaireId: string,
  contactId: string,
  date: string,
): Promise<QuestionnaireCycle | undefined> {
  const cycle = await getOrCreateCycle(questionnaireId, contactId, date);
  if (
    cycle.status === 'completed' ||
    cycle.status === 'notified' ||
    cycle.status === 'sending' ||
    (cycle.status === 'in_progress' && cycle.template_sent_at)
  ) {
    return undefined;
  }
  const stamp = now();
  return one<QuestionnaireCycle>(
    `UPDATE questionnaire_cycles
     SET status = 'sending', updated_at = $1, error = ''
     WHERE id = $2
       AND (
         status IN ('open', 'failed')
         OR (status = 'in_progress' AND COALESCE(template_sent_at, '') = '')
       )
     RETURNING id, questionnaire_id, contact_id, revision_id, occurrence_date, status,
               template_sent_at, completed_at, error, updated_at, last_prompted_at, last_inbound_at`,
    [stamp, cycle.id],
  );
}

export async function markCycleNotified(cycleId: string): Promise<void> {
  const stamp = now();
  await run(
    `UPDATE questionnaire_cycles
     SET status = CASE
           WHEN status = 'completed' THEN 'completed'
           WHEN EXISTS (
             SELECT 1 FROM questionnaire_answers answer
             WHERE answer.cycle_id = questionnaire_cycles.id
           ) THEN 'in_progress'
           WHEN status IN ('open', 'sending', 'failed') THEN 'notified'
           ELSE status
         END,
         template_sent_at = $1, last_prompted_at = $1,
         error = '', updated_at = $1
     WHERE id = $2`,
    [stamp, cycleId],
  );
}

export async function markCyclePrompted(cycleId: string): Promise<void> {
  const stamp = now();
  await run(
    `UPDATE questionnaire_cycles
     SET status = CASE WHEN status = 'open' THEN 'notified' ELSE status END,
         last_prompted_at = $1, updated_at = $1
     WHERE id = $2`,
    [stamp, cycleId],
  );
}

export async function markCycleFailed(cycleId: string, error: string): Promise<void> {
  const stamp = now();
  await run(
    `UPDATE questionnaire_cycles
     SET status = 'failed', error = $1, updated_at = $2
     WHERE id = $3 AND status <> 'completed'`,
    [error, stamp, cycleId],
  );
}

export async function markCycleCompleted(cycleId: string): Promise<void> {
  const stamp = now();
  await run(
    `UPDATE questionnaire_cycles
     SET status = 'completed', completed_at = $1, error = '', updated_at = $1
     WHERE id = $2`,
    [stamp, cycleId],
  );
}

export async function markCycleInProgress(cycleId: string): Promise<void> {
  const stamp = now();
  await run(
    `UPDATE questionnaire_cycles
     SET status = 'in_progress', completed_at = '', last_inbound_at = $1,
         error = '', updated_at = $1
     WHERE id = $2`,
    [stamp, cycleId],
  );
}

export async function reopenCycle(cycleId: string): Promise<void> {
  await markCycleInProgress(cycleId);
}

export async function listCycleAnswers(cycleId: string): Promise<CycleAnswer[]> {
  return many<CycleAnswer>(
    `SELECT id, cycle_id, question_id, answer_text, answer_type, media_url
     FROM questionnaire_answers WHERE cycle_id = $1 ORDER BY created_at`,
    [cycleId],
  );
}

export async function upsertAnswers(
  cycleId: string,
  answers: { questionId: string; text: string; type: string; mediaUrl?: string }[],
): Promise<CycleAnswer[]> {
  const stamp = now();
  for (const answer of answers) {
    if (!answer.questionId || !answer.text.trim()) continue;
    await run(
      `INSERT INTO questionnaire_answers(id, cycle_id, question_id, answer_text, answer_type, media_url, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (cycle_id, question_id) DO UPDATE SET
         answer_text = excluded.answer_text,
         answer_type = excluded.answer_type,
         media_url = excluded.media_url,
         updated_at = excluded.updated_at`,
      [
        randomUUID(),
        cycleId,
        answer.questionId,
        answer.text.trim(),
        answer.type || 'text',
        answer.mediaUrl || '',
        stamp,
      ],
    );
  }
  if (answers.some((answer) => answer.questionId && answer.text.trim())) {
    await markCycleInProgress(cycleId);
  }
  return listCycleAnswers(cycleId);
}

export async function deleteCycleAnswers(cycleId: string, questionIds: string[] = []): Promise<void> {
  if (!questionIds.length) {
    await run('DELETE FROM questionnaire_answers WHERE cycle_id = $1', [cycleId]);
    return;
  }
  await run('DELETE FROM questionnaire_answers WHERE cycle_id = $1 AND question_id = ANY($2::text[])', [
    cycleId,
    questionIds,
  ]);
}

export function missingQuestions(
  questions: QuestionnaireQuestion[],
  answers: CycleAnswer[],
): QuestionnaireQuestion[] {
  const answered = new Set(answers.map((item) => item.question_id));
  return questions.filter((item) => !answered.has(item.id));
}

export async function listCollectedData(questionnaireId = ''): Promise<CollectedRow[]> {
  const params: string[] = [];
  const filter = questionnaireId
    ? (params.push(questionnaireId), 'AND q.id = $1')
    : '';
  return many<CollectedRow>(
    `SELECT cyc.id AS cycle_id, q.id AS questionnaire_id, rev.name AS questionnaire_name,
            ct.id AS contact_id, ct.name AS contact_name, ct.phone AS contact_phone,
            cyc.occurrence_date, cyc.status AS cycle_status,
            qq.question_id, qq.body AS question_body,
            COALESCE(ans.answer_text, '') AS answer_text,
            COALESCE(ans.answer_type, '') AS answer_type,
            COALESCE(ans.media_url, '') AS media_url,
            COALESCE(ans.updated_at, ans.created_at, '') AS answered_at
     FROM questionnaire_cycles cyc
     JOIN questionnaires q ON q.id = cyc.questionnaire_id
     JOIN questionnaire_revisions rev ON rev.id = cyc.revision_id
     JOIN contacts ct ON ct.id = cyc.contact_id
     JOIN questionnaire_revision_questions qq ON qq.revision_id = rev.id
     LEFT JOIN questionnaire_answers ans ON ans.cycle_id = cyc.id AND ans.question_id = qq.question_id
     WHERE ct.hidden = 0
       ${filter}
     ORDER BY cyc.occurrence_date DESC, rev.name, ct.name, qq.sort_order`,
    params,
  );
}
