import { randomUUID } from 'node:crypto';
import { many, one, run, withTransaction } from './db.js';
import { isFormsBotExportField } from './forms-bot-fields.js';
import { isFormKind, type FormKind } from './forms-fields.js';
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
  /** Valor fixado pelo padrão Forms (ex.: produto de “Qtd de ABACATE?”). */
  fixed_value?: string;
};

export type Questionnaire = {
  id: string;
  revisionId?: string;
  name: string;
  greeting: string;
  frequency: string;
  weekday: number;
  send_time: string;
  template_id: string;
  version: number;
  active: number;
  created_at: string;
  updated_at: string;
  /** Valores fixos (RFQ legado ou Forms). Resposta do contato sobrescreve. */
  defaultValues: Record<string, string>;
  /** Quando preenchido, respostas materializam em forms_documents. */
  sourcePresetId: string;
  formKind: string;
  companyOdooId: string;
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
  templateId?: string;
  active: boolean;
  defaultValues?: Record<string, string>;
  questions: { id?: string; body: string; expectedType: string; exportField?: string; fixedValue?: string }[];
  contactIds: string[];
  sourcePresetId?: string;
  formKind?: string;
  companyOdooId?: string;
  /**
   * Uso interno via {@link upsertQuestionnaire}. Não expor nas rotas HTTP da UI:
   * PUT/POST devem falhar se o id não existir.
   */
  createIfMissing?: boolean;
};

type QuestionnaireRow = Omit<
  Questionnaire,
  'questions' | 'contactIds' | 'defaultValues' | 'sourcePresetId' | 'formKind' | 'companyOdooId'
> & {
  default_values_json?: string;
  source_preset_id?: string;
  form_kind?: string;
  company_odoo_id?: string;
};

export function normalizeDefaultValues(
  raw: unknown,
  formKind: string = '',
): Record<string, string> {
  if (!raw) return {};
  let source: unknown = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const out: Record<string, string> = {};
  const kind = isFormKind(formKind) ? formKind : '';
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const field = String(key || '').trim();
    if (!field) continue;
    if (kind) {
      if (!isFormsBotExportField(kind, field)) continue;
    } else if (!isRfqFieldKey(field)) {
      continue;
    }
    const text = String(value ?? '').trim();
    if (text) out[field] = text;
  }
  return out;
}

function hydrateQuestionnaire(
  row: QuestionnaireRow,
  questions: QuestionnaireQuestion[],
  contactIds: string[],
): Questionnaire {
  const {
    default_values_json: rawDefaults,
    source_preset_id: sourcePresetId = '',
    form_kind: formKind = '',
    company_odoo_id: companyOdooId = '',
    ...rest
  } = row;
  return {
    ...rest,
    sourcePresetId: sourcePresetId || '',
    formKind: formKind || '',
    companyOdooId: companyOdooId || '',
    defaultValues: normalizeDefaultValues(rawDefaults, formKind || ''),
    questions,
    contactIds,
  };
}

export async function listQuestionnaires(): Promise<Questionnaire[]> {
  const rows = await many<QuestionnaireRow>(
    `SELECT id, name, greeting, frequency, weekday, send_time, template_id, version,
            active, created_at, updated_at, COALESCE(default_values_json, '{}') AS default_values_json,
            COALESCE(source_preset_id, '') AS source_preset_id,
            COALESCE(form_kind, '') AS form_kind,
            COALESCE(company_odoo_id, '') AS company_odoo_id
     FROM questionnaires WHERE deleted_at = '' ORDER BY name, created_at`,
  );
  const questions = await many<QuestionnaireQuestion>(
    `SELECT id, questionnaire_id, body, expected_type, COALESCE(export_field, '') AS export_field, sort_order,
            fixed_value
     FROM questionnaire_questions ORDER BY sort_order, created_at`,
  );
  const assignments = await many<{ questionnaire_id: string; contact_id: string }>(
    'SELECT questionnaire_id, contact_id FROM questionnaire_assignments',
  );
  return rows.map((row) =>
    hydrateQuestionnaire(
      row,
      questions.filter((item) => item.questionnaire_id === row.id),
      assignments
        .filter((item) => item.questionnaire_id === row.id)
        .map((item) => item.contact_id),
    ),
  );
}

export async function getQuestionnaire(
  id: string,
  includeDeleted = false,
): Promise<Questionnaire | undefined> {
  const row = await one<QuestionnaireRow>(
    `SELECT id, name, greeting, frequency, weekday, send_time, template_id, version,
            active, created_at, updated_at, COALESCE(default_values_json, '{}') AS default_values_json,
            COALESCE(source_preset_id, '') AS source_preset_id,
            COALESCE(form_kind, '') AS form_kind,
            COALESCE(company_odoo_id, '') AS company_odoo_id
     FROM questionnaires WHERE id = $1 AND ($2::boolean OR deleted_at = '')`,
    [id, includeDeleted],
  );
  if (!row) return undefined;
  const questions = await many<QuestionnaireQuestion>(
    `SELECT id, questionnaire_id, body, expected_type, COALESCE(export_field, '') AS export_field, sort_order,
            fixed_value
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
  return hydrateQuestionnaire(row, questions, contactIds);
}

export async function saveQuestionnaire(input: QuestionnaireInput): Promise<Questionnaire> {
  return withTransaction(() => saveQuestionnaireTransaction(input));
}

/**
 * Upsert com id determinístico para geradores internos (Forms Bot, futuros syncs).
 * Reutilize esta função em vez de novos caminhos de INSERT/upsert.
 * Rotas da UI devem continuar chamando {@link saveQuestionnaire} sem createIfMissing.
 */
export async function upsertQuestionnaire(
  input: Omit<QuestionnaireInput, 'createIfMissing' | 'id'> & { id: string },
): Promise<Questionnaire> {
  const id = String(input.id || '').trim();
  if (!id) throw new Error('Id do questionário é obrigatório para upsert');
  return saveQuestionnaire({ ...input, id, createIfMissing: true });
}

async function saveQuestionnaireTransaction(input: QuestionnaireInput): Promise<Questionnaire> {
  const name = input.name.trim();
  if (!name) throw new Error('Dê um nome ao questionário');
  if (!FREQUENCIES.has(input.frequency)) throw new Error('Frequência inválida');
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(input.sendTime)) throw new Error('Horário inválido. Use HH:MM');
  if (input.weekday < 0 || input.weekday > 6) throw new Error('Dia da semana inválido');

  const formKindRaw = String(input.formKind || '').trim();
  const formKind: FormKind | '' = isFormKind(formKindRaw) ? formKindRaw : '';
  const sourcePresetId = String(input.sourcePresetId || '').trim();
  const companyOdooId = String(input.companyOdooId || '').trim();

  const questions = input.questions
    .map((item) => {
      const exportField = String(item.exportField || '').trim();
      if (formKind) {
        if (!isFormsBotExportField(formKind, exportField)) {
          throw new Error(`Campo Forms inválido: ${exportField}`);
        }
      } else if (!isRfqFieldKey(exportField)) {
        throw new Error(`Campo de exportação inválido: ${exportField}`);
      }
      return {
        id: item.id || randomUUID(),
        body: item.body.trim(),
        expectedType: EXPECTED.has(item.expectedType) ? item.expectedType : 'any',
        exportField,
        fixedValue: String(item.fixedValue || '').trim(),
      };
    })
    .filter((item) => item.body);
  if (!questions.length) throw new Error('Inclua ao menos uma pergunta');

  const contactIds = [...new Set(input.contactIds.map((id) => id.trim()).filter(Boolean))];
  const defaultValues = normalizeDefaultValues(input.defaultValues, formKind);
  const id = input.id || randomUUID();
  const stamp = now();
  const existing = input.id ? await getQuestionnaire(input.id, true) : undefined;
  if (input.id && !existing && !input.createIfMissing) {
    throw new Error('Questionário não encontrado');
  }
  const version = existing ? existing.version + 1 : 1;
  const templateId = String(input.templateId ?? existing?.template_id ?? '').trim();

  await run(
    `INSERT INTO questionnaires(
       id, name, greeting, frequency, weekday, send_time, template_id, version,
       active, deleted_at, created_at, updated_at, default_values_json,
       source_preset_id, form_kind, company_odoo_id
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, '', $10, $11, $12, $13, $14, $15)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       greeting = excluded.greeting,
       frequency = excluded.frequency,
       weekday = excluded.weekday,
       send_time = excluded.send_time,
       template_id = excluded.template_id,
       version = excluded.version,
       active = excluded.active,
       deleted_at = '',
       updated_at = excluded.updated_at,
       default_values_json = excluded.default_values_json,
       source_preset_id = excluded.source_preset_id,
       form_kind = excluded.form_kind,
       company_odoo_id = excluded.company_odoo_id`,
    [
      id,
      name,
      input.greeting.trim(),
      input.frequency,
      input.weekday,
      input.sendTime,
      templateId,
      version,
      input.active ? 1 : 0,
      existing?.created_at || stamp,
      stamp,
      JSON.stringify(defaultValues),
      sourcePresetId || existing?.sourcePresetId || '',
      formKind || existing?.formKind || '',
      companyOdooId || existing?.companyOdooId || '',
    ],
  );

  const questionIds = questions.map((item) => item.id);
  await run(
    'DELETE FROM questionnaire_questions WHERE questionnaire_id = $1 AND NOT (id = ANY($2::text[]))',
    [id, questionIds],
  );

  for (const [index, item] of questions.entries()) {
    await run(
      `INSERT INTO questionnaire_questions(
         id, questionnaire_id, body, expected_type, export_field, sort_order, created_at, fixed_value
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(id) DO UPDATE SET
         body = excluded.body,
         expected_type = excluded.expected_type,
         export_field = excluded.export_field,
         sort_order = excluded.sort_order,
         fixed_value = excluded.fixed_value`,
      [item.id, id, item.body, item.expectedType, item.exportField, index, stamp, item.fixedValue],
    );
  }

  await syncAssignments(id, contactIds, stamp);
  await createRevision({
    questionnaireId: id,
    version,
    name,
    greeting: input.greeting.trim(),
    frequency: input.frequency,
    weekday: input.weekday,
    sendTime: input.sendTime,
    templateId,
    questions,
    stamp,
  });
  const saved = await getQuestionnaire(id);
  if (!saved) throw new Error('Falha ao salvar questionário');
  return saved;
}

export async function deleteQuestionnaire(id: string): Promise<void> {
  await withTransaction(async () => {
    await run('UPDATE questionnaires SET active = 0, deleted_at = $2, updated_at = $2 WHERE id = $1', [
      id,
      now(),
    ]);
    await run('DELETE FROM questionnaire_assignments WHERE questionnaire_id = $1', [id]);
  });
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

export async function getQuestionnaireRevision(revisionId: string): Promise<Questionnaire | undefined> {
  const row = await one<{
    id: string;
    questionnaire_id: string;
    version: number;
    name: string;
    greeting: string;
    frequency: string;
    weekday: number;
    send_time: string;
    template_id: string;
    created_at: string;
  }>(
    `SELECT id, questionnaire_id, version, name, greeting, frequency, weekday,
            send_time, template_id, created_at
     FROM questionnaire_revisions WHERE id = $1`,
    [revisionId],
  );
  if (!row) return undefined;
  const questions = await many<QuestionnaireQuestion>(
    `SELECT question_id AS id, $2::text AS questionnaire_id, body, expected_type,
            export_field, sort_order, fixed_value
     FROM questionnaire_revision_questions
     WHERE revision_id = $1 ORDER BY sort_order`,
    [revisionId, row.questionnaire_id],
  );
  return {
    id: row.questionnaire_id,
    revisionId: row.id,
    name: row.name,
    greeting: row.greeting,
    frequency: row.frequency,
    weekday: row.weekday,
    send_time: row.send_time,
    template_id: row.template_id,
    version: row.version,
    active: 1,
    created_at: row.created_at,
    updated_at: row.created_at,
    defaultValues: {},
    sourcePresetId: '',
    formKind: '',
    companyOdooId: '',
    questions,
    contactIds: [],
  };
}

async function createRevision(input: {
  questionnaireId: string;
  version: number;
  name: string;
  greeting: string;
  frequency: string;
  weekday: number;
  sendTime: string;
  templateId: string;
  questions: { id: string; body: string; expectedType: string; exportField: string; fixedValue: string }[];
  stamp: string;
}): Promise<void> {
  const revisionId = randomUUID();
  await run(
    `INSERT INTO questionnaire_revisions(
       id, questionnaire_id, version, name, greeting, frequency, weekday, send_time, template_id, created_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      revisionId,
      input.questionnaireId,
      input.version,
      input.name,
      input.greeting,
      input.frequency,
      input.weekday,
      input.sendTime,
      input.templateId,
      input.stamp,
    ],
  );
  for (const [sortOrder, question] of input.questions.entries()) {
    await run(
      `INSERT INTO questionnaire_revision_questions(
         revision_id, question_id, body, expected_type, export_field, sort_order, fixed_value
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        revisionId,
        question.id,
        question.body,
        question.expectedType,
        question.exportField,
        sortOrder,
        question.fixedValue,
      ],
    );
  }
}
