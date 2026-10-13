import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { runsOnWeekday } from './plans.js';
import { getQuestionnaire, type Questionnaire, type QuestionnaireQuestion } from './questionnaires.js';

const now = () => new Date().toISOString();

export type CycleStatus = 'open' | 'sending' | 'notified' | 'completed' | 'failed';

export type QuestionnaireCycle = {
  id: string;
  questionnaire_id: string;
  contact_id: string;
  occurrence_date: string;
  status: CycleStatus;
  template_sent_at: string;
  completed_at: string;
  error: string;
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

export async function findActiveCycleForContact(
  contactId: string,
  date: string,
  weekday: number,
): Promise<ActiveCycleContext | undefined> {
  const candidates = await many<{
    questionnaire_id: string;
    frequency: string;
    weekday: number;
    send_time: string;
  }>(
    `SELECT q.id AS questionnaire_id, q.frequency, q.weekday, q.send_time
     FROM questionnaire_assignments a
     JOIN questionnaires q ON q.id = a.questionnaire_id
     WHERE a.contact_id = $1 AND q.active = 1
     ORDER BY q.send_time, q.name`,
    [contactId],
  );

  for (const item of candidates) {
    if (!runsOnWeekday(item, weekday)) continue;
    const questionnaire = await getQuestionnaire(item.questionnaire_id);
    if (!questionnaire?.questions.length) continue;
    const cycle = await getOrCreateCycle(item.questionnaire_id, contactId, date);
    if (cycle.status === 'completed') continue;
    const answers = await listCycleAnswers(cycle.id);
    const answered = new Set(answers.map((row) => row.question_id));
    return {
      cycle,
      questionnaire,
      answers,
      missing: questionnaire.questions.filter((question) => !answered.has(question.id)),
    };
  }
  return undefined;
}

export async function listDueQuestionnaireSends(weekday: number): Promise<DueQuestionnaireSend[]> {
  const rows = await many<DueQuestionnaireSend>(
    `SELECT q.id AS questionnaire_id, q.name AS questionnaire_name, q.greeting, q.send_time, q.frequency, q.weekday,
            c.id AS contact_id, c.name, c.phone
     FROM questionnaire_assignments a
     JOIN questionnaires q ON q.id = a.questionnaire_id
     JOIN contacts c ON c.id = a.contact_id
     WHERE q.active = 1
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
    `SELECT id, questionnaire_id, contact_id, occurrence_date, status, template_sent_at, completed_at, error
     FROM questionnaire_cycles
     WHERE questionnaire_id = $1 AND contact_id = $2 AND occurrence_date = $3`,
    [questionnaireId, contactId, date],
  );
  if (existing) return existing;

  const stamp = now();
  const id = randomUUID();
  try {
    await run(
      `INSERT INTO questionnaire_cycles(
         id, questionnaire_id, contact_id, occurrence_date, status, template_sent_at, completed_at, error, created_at, updated_at
       ) VALUES($1, $2, $3, $4, 'open', '', '', '', $5, $5)`,
      [id, questionnaireId, contactId, date, stamp],
    );
  } catch {
    // Concorrência: outro processo criou o ciclo do dia.
  }
  const created = await one<QuestionnaireCycle>(
    `SELECT id, questionnaire_id, contact_id, occurrence_date, status, template_sent_at, completed_at, error
     FROM questionnaire_cycles
     WHERE questionnaire_id = $1 AND contact_id = $2 AND occurrence_date = $3`,
    [questionnaireId, contactId, date],
  );
  if (!created) throw new Error('Falha ao abrir ciclo do questionário');
  return created;
}

/** Reserva o ciclo para envio do template; retorna null se já foi notificado/concluído ou outro worker pegou. */
export async function claimCycleForSend(
  questionnaireId: string,
  contactId: string,
  date: string,
): Promise<QuestionnaireCycle | undefined> {
  const cycle = await getOrCreateCycle(questionnaireId, contactId, date);
  if (cycle.status === 'completed' || cycle.status === 'notified' || cycle.status === 'sending') {
    return undefined;
  }
  const stamp = now();
  const claimed = await one<QuestionnaireCycle>(
    `UPDATE questionnaire_cycles
     SET status = 'sending', updated_at = $1, error = ''
     WHERE id = $2 AND status IN ('open', 'failed')
     RETURNING id, questionnaire_id, contact_id, occurrence_date, status, template_sent_at, completed_at, error`,
    [stamp, cycle.id],
  );
  return claimed;
}

export async function markCycleNotified(cycleId: string): Promise<void> {
  const stamp = now();
  await run(
    `UPDATE questionnaire_cycles
     SET status = 'notified', template_sent_at = $1, error = '', updated_at = $1
     WHERE id = $2 AND status <> 'completed'`,
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
  return listCycleAnswers(cycleId);
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
    `SELECT cyc.id AS cycle_id, q.id AS questionnaire_id, q.name AS questionnaire_name,
            ct.id AS contact_id, ct.name AS contact_name, ct.phone AS contact_phone,
            cyc.occurrence_date, cyc.status AS cycle_status,
            qq.id AS question_id, qq.body AS question_body,
            COALESCE(ans.answer_text, '') AS answer_text,
            COALESCE(ans.answer_type, '') AS answer_type,
            COALESCE(ans.media_url, '') AS media_url,
            COALESCE(ans.updated_at, ans.created_at, '') AS answered_at
     FROM questionnaire_cycles cyc
     JOIN questionnaires q ON q.id = cyc.questionnaire_id
     JOIN contacts ct ON ct.id = cyc.contact_id
     JOIN questionnaire_questions qq ON qq.questionnaire_id = q.id
     LEFT JOIN questionnaire_answers ans ON ans.cycle_id = cyc.id AND ans.question_id = qq.id
     WHERE ct.hidden = 0 ${filter}
     ORDER BY cyc.occurrence_date DESC, q.name, ct.name, qq.sort_order`,
    params,
  );
}
