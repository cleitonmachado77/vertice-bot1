import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { isRfqFieldKey } from './rfq-fields.js';

const now = () => new Date().toISOString();
const FREQUENCIES = new Set(['daily', 'weekdays', 'weekly']);
const EXPECTED = new Set(['any', 'text', 'audio', 'image', 'video']);

/** Texto curto recomendado para o template Meta de primeiro contato do questionário. */
export const QUESTIONNAIRE_FIRST_CONTACT_PHRASE =
  'Oi {{1}}! Aqui é a Vértice. Pode responder o questionário de acompanhamento?';

export type QuestionnaireQuestion = {
  id: string;
  questionnaire_id: string;
  body: string;
  expected_type: string;
  export_field: string;
  sort_order: number;
};

export type Questionnaire = {
  id: string;
  name: string;
  greeting: string;
  frequency: string;
  weekday: number;
  send_time: string;
  active: number;
  created_at: string;
  updated_at: string;
  questions: QuestionnaireQuestion[];
  contactIds: string[];
};

export type QuestionnaireInput = {
  id?: string;
  name: string;
  greeting: string;
  frequency: string;
  weekday: number;
  sendTime: string;
  active: boolean;
  questions: { id?: string; body: string; expectedType: string; exportField?: string }[];
  contactIds: string[];
};

export async function listQuestionnaires(): Promise<Questionnaire[]> {
  const rows = await many<Omit<Questionnaire, 'questions' | 'contactIds'>>(
    `SELECT id, name, greeting, frequency, weekday, send_time, active, created_at, updated_at
     FROM questionnaires ORDER BY name, created_at`,
  );
  const questions = await many<QuestionnaireQuestion>(
    `SELECT id, questionnaire_id, body, expected_type, COALESCE(export_field, '') AS export_field, sort_order
     FROM questionnaire_questions ORDER BY sort_order, created_at`,
  );
  const assignments = await many<{ questionnaire_id: string; contact_id: string }>(
    'SELECT questionnaire_id, contact_id FROM questionnaire_assignments',
  );
  return rows.map((row) => ({
    ...row,
    questions: questions.filter((item) => item.questionnaire_id === row.id),
    contactIds: assignments
      .filter((item) => item.questionnaire_id === row.id)
      .map((item) => item.contact_id),
  }));
}

export async function getQuestionnaire(id: string): Promise<Questionnaire | undefined> {
  const row = await one<Omit<Questionnaire, 'questions' | 'contactIds'>>(
    `SELECT id, name, greeting, frequency, weekday, send_time, active, created_at, updated_at
     FROM questionnaires WHERE id = $1`,
    [id],
  );
  if (!row) return undefined;
  const questions = await many<QuestionnaireQuestion>(
    `SELECT id, questionnaire_id, body, expected_type, COALESCE(export_field, '') AS export_field, sort_order
     FROM questionnaire_questions WHERE questionnaire_id = $1
     ORDER BY sort_order, created_at`,
    [id],
  );
  const contactIds = (
    await many<{ contact_id: string }>(
      'SELECT contact_id FROM questionnaire_assignments WHERE questionnaire_id = $1',
      [id],
    )
  ).map((item) => item.contact_id);
  return { ...row, questions, contactIds };
}

export async function saveQuestionnaire(input: QuestionnaireInput): Promise<Questionnaire> {
  const name = input.name.trim();
  if (!name) throw new Error('Dê um nome ao questionário');
  if (!FREQUENCIES.has(input.frequency)) throw new Error('Frequência inválida');
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(input.sendTime)) throw new Error('Horário inválido. Use HH:MM');
  if (input.weekday < 0 || input.weekday > 6) throw new Error('Dia da semana inválido');

  const questions = input.questions
    .map((item) => {
      const exportField = String(item.exportField || '').trim();
      if (!isRfqFieldKey(exportField)) {
        throw new Error(`Campo de exportação inválido: ${exportField}`);
      }
      return {
        id: item.id || randomUUID(),
        body: item.body.trim(),
        expectedType: EXPECTED.has(item.expectedType) ? item.expectedType : 'any',
        exportField,
      };
    })
    .filter((item) => item.body);
  if (!questions.length) throw new Error('Inclua ao menos uma pergunta');

  const contactIds = [...new Set(input.contactIds.map((id) => id.trim()).filter(Boolean))];
  const id = input.id || randomUUID();
  const stamp = now();
  const existing = input.id ? await getQuestionnaire(input.id) : undefined;
  if (input.id && !existing) throw new Error('Questionário não encontrado');

  await run(
    `INSERT INTO questionnaires(id, name, greeting, frequency, weekday, send_time, active, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       greeting = excluded.greeting,
       frequency = excluded.frequency,
       weekday = excluded.weekday,
       send_time = excluded.send_time,
       active = excluded.active,
       updated_at = excluded.updated_at`,
    [
      id,
      name,
      input.greeting.trim(),
      input.frequency,
      input.weekday,
      input.sendTime,
      input.active ? 1 : 0,
      existing?.created_at || stamp,
      stamp,
    ],
  );

  const questionIds = questions.map((item) => item.id);
  await run(
    'DELETE FROM questionnaire_questions WHERE questionnaire_id = $1 AND NOT (id = ANY($2::text[]))',
    [id, questionIds],
  );

  for (const [index, item] of questions.entries()) {
    await run(
      `INSERT INTO questionnaire_questions(id, questionnaire_id, body, expected_type, export_field, sort_order, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET
         body = excluded.body,
         expected_type = excluded.expected_type,
         export_field = excluded.export_field,
         sort_order = excluded.sort_order`,
      [item.id, id, item.body, item.expectedType, item.exportField, index, stamp],
    );
  }

  await syncAssignments(id, contactIds, stamp);
  const saved = await getQuestionnaire(id);
  if (!saved) throw new Error('Falha ao salvar questionário');
  return saved;
}

export async function deleteQuestionnaire(id: string): Promise<void> {
  const cycles = await many<{ id: string }>('SELECT id FROM questionnaire_cycles WHERE questionnaire_id = $1', [id]);
  const cycleIds = cycles.map((item) => item.id);
  if (cycleIds.length) {
    await run('DELETE FROM questionnaire_answers WHERE cycle_id = ANY($1::text[])', [cycleIds]);
  }
  await run('DELETE FROM questionnaire_cycles WHERE questionnaire_id = $1', [id]);
  await run('DELETE FROM questionnaire_assignments WHERE questionnaire_id = $1', [id]);
  await run('DELETE FROM questionnaire_questions WHERE questionnaire_id = $1', [id]);
  await run('DELETE FROM questionnaires WHERE id = $1', [id]);
}

export function previewQuestionnaireBody(greeting: string, questions: { body: string }[]): string {
  const lines = questions.map((item, index) => `${index + 1}) ${item.body}`).filter(Boolean);
  return [greeting.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

async function syncAssignments(questionnaireId: string, contactIds: string[], stamp: string): Promise<void> {
  if (contactIds.length) {
    await run(
      'DELETE FROM questionnaire_assignments WHERE questionnaire_id = $1 AND NOT (contact_id = ANY($2::text[]))',
      [questionnaireId, contactIds],
    );
  } else {
    await run('DELETE FROM questionnaire_assignments WHERE questionnaire_id = $1', [questionnaireId]);
  }
  for (const contactId of contactIds) {
    await run(
      `INSERT INTO questionnaire_assignments(questionnaire_id, contact_id, created_at)
       VALUES($1, $2, $3) ON CONFLICT DO NOTHING`,
      [questionnaireId, contactId, stamp],
    );
  }
}
