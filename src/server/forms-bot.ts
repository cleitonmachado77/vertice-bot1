import { getSetting, many, one, run } from './db.js';
import { zonedNow } from './clock.js';
import {
  createFormDocument,
  saveFormDocument,
  type FormDocument,
} from './forms.js';
import { resolveCatalogValue } from './forms-bot-match.js';
import {
  FORMS_BOT_LINES_FIELD,
  FORMS_BOT_LINES_MORE_FIELD,
  formsBotQuestionnaireId,
  quantityOnlyLinesQuestion,
} from './forms-bot-fields.js';
import { planBotLines } from './forms-bot-lines.js';
import {
  KIND_LABELS,
  documentTitle,
  headerFieldsFor,
  isFormKind,
  lineFieldsFor,
  type FormField,
  type FormKind,
} from './forms-fields.js';
import { isUnusableQuestionnaireAnswer } from './questionnaire-rules.js';
import {
  getFormPreset,
  getFormPresetById,
  type FormPreset,
  updateFormPreset,
} from './forms-presets.js';
import { markDocSyncPending, scheduleOdooPush } from './odoo-sync.js';
import { enqueueOutbound } from './outbound-outbox.js';
import { normalizeWhatsappPhone } from './phone.js';
import {
  resolveFirstContactTemplate,
  variablesFor,
} from './questionnaire-dispatch.js';
import {
  QUESTIONNAIRE_FIRST_CONTACT_PHRASE,
  getQuestionnaire,
  upsertQuestionnaire,
  type Questionnaire,
} from './questionnaires.js';
import {
  listCycleAnswers,
  markCycleNotified,
  openFreshCycle,
  rememberCyclePrompt,
  type CycleAnswer,
} from './questionnaire-cycles.js';
import { getContact } from './store.js';
import { hasOpenCustomerWindow } from './thread.js';

export { FORMS_BOT_LINES_FIELD, formsBotQuestionnaireId, isFormsBotExportField } from './forms-bot-fields.js';

function questionBodyFor(field: FormField): string {
  if (field.date) return `${field.label}? (dd/mm/aaaa)`;
  if (field.options?.length) {
    return `${field.label}? (${field.options.map((item) => item.label).join(' / ')})`;
  }
  if (field.catalog || field.key === 'vendor' || field.key === 'customer' || field.key === 'product') {
    return `${field.label}?`;
  }
  return `${field.label}?`;
}

function linesQuestionBody(
  kind: FormKind,
  visibleLineKeys: string[],
  templateLines: Array<{ values: Record<string, string> }> = [],
): string {
  const labels = lineFieldsFor(kind)
    .filter((field) => visibleLineKeys.includes(field.key))
    .map((field) => field.label);
  const hint = labels.length ? labels.join(', ') : 'produto, quantidade, preço';
  const productDefault = String(templateLines[0]?.values?.product || '').trim();
  if (visibleLineKeys.length === 1 && visibleLineKeys[0] === 'quantity' && productDefault) {
    return quantityOnlyLinesQuestion(productDefault);
  }
  if (productDefault && visibleLineKeys.includes('quantity')) {
    return `${hint}? (padrão: ${productDefault})`;
  }
  return `${hint}?`;
}

/** Pergunta linhas se algum campo visível ainda precisa do usuário. */
function needsLinesQuestion(
  visibleLineKeys: string[],
  templateLines: Array<{ values: Record<string, string> }>,
): boolean {
  if (!visibleLineKeys.length) return false;
  if (!templateLines.length) return true;
  return templateLines.some((line) =>
    visibleLineKeys.some((key) => !String(line.values?.[key] || '').trim()),
  );
}

export function buildFormsBotQuestions(preset: FormPreset): {
  questions: { id?: string; body: string; expectedType: string; exportField: string; fixedValue?: string }[];
  defaultValues: Record<string, string>;
} {
  const visibleHeader = new Set(preset.visible.header || []);
  const visibleLines = new Set(preset.visible.lines || []);
  const defaultValues: Record<string, string> = {};
  const questions: { id?: string; body: string; expectedType: string; exportField: string; fixedValue?: string }[] = [];

  for (const field of headerFieldsFor(preset.kind)) {
    if (field.readonly) continue;
    if (!visibleHeader.has(field.key)) continue;
    const presetValue = String(preset.header[field.key] || '').trim();
    if (presetValue) {
      defaultValues[field.key] = presetValue;
      continue;
    }
    questions.push({
      body: questionBodyFor(field),
      expectedType: 'any',
      exportField: field.key,
    });
  }

  if (lineFieldsFor(preset.kind).length && visibleLines.size) {
    const visibleKeys = [...visibleLines];
    const templateLines = preset.lines || [];
    if (needsLinesQuestion(visibleKeys, templateLines)) {
      // Produto do padrão sem “Produto” visível: o usuário só informa quantidade/preço.
      const productDefault = String(templateLines[0]?.values?.product || '').trim();
      questions.push({
        body: linesQuestionBody(preset.kind, visibleKeys, templateLines),
        expectedType: 'any',
        exportField: FORMS_BOT_LINES_FIELD,
        fixedValue: visibleLines.has('product') ? '' : productDefault,
      });
      questions.push({
        body: 'Mais produtos? (produto + qtd, ou “não”)',
        expectedType: 'any',
        exportField: FORMS_BOT_LINES_MORE_FIELD,
      });
    }
  }

  return { questions, defaultValues };
}

async function resolvePresetBotContact(preset: FormPreset): Promise<{ id: string; name: string; phone: string }> {
  const contactId = String(preset.bot_contact_id || '').trim();
  if (!contactId) {
    throw new Error('Selecione o contato que receberá o questionário neste padrão');
  }
  const contact = await getContact(contactId);
  if (!contact || Number(contact.hidden) === 1) {
    throw new Error('Contato do Bot não encontrado. Cadastre ou selecione outro no padrão.');
  }
  const phone = normalizeWhatsappPhone(contact.phone || '');
  if (!phone) {
    throw new Error('O contato selecionado não tem WhatsApp válido');
  }
  return { id: contact.id, name: contact.name || phone, phone };
}

export async function syncFormsBotQuestionnaire(preset: FormPreset): Promise<Questionnaire | null> {
  const questionnaireId = formsBotQuestionnaireId(preset.id);
  if (!preset.bot_enabled) {
    const existing = await getQuestionnaire(questionnaireId, true);
    if (existing) {
      await run(
        `UPDATE questionnaires
         SET active = 0, deleted_at = CASE WHEN deleted_at = '' THEN $2 ELSE deleted_at END, updated_at = $2
         WHERE id = $1`,
        [questionnaireId, new Date().toISOString()],
      );
      await run('DELETE FROM questionnaire_assignments WHERE questionnaire_id = $1', [questionnaireId]);
    }
    return null;
  }

  const { questions, defaultValues } = buildFormsBotQuestions(preset);
  if (!questions.length && !Object.keys(defaultValues).length) {
    throw new Error('Marque campos “Mostrar” (sem valor padrão) para o Bot ter o que perguntar');
  }
  if (!questions.length) {
    throw new Error('Todos os campos visíveis já têm valor padrão — deixe algum vazio para o Bot perguntar');
  }

  const recipient = await resolvePresetBotContact(preset);
  const contactIds = [recipient.id];

  const kindLabel = KIND_LABELS[preset.kind];
  const greeting = `Oi {{1}}! ${kindLabel} — ${preset.name}`;

  const existing = await getQuestionnaire(questionnaireId, true);
  const saved = await upsertQuestionnaire({
    id: questionnaireId,
    name: `[Forms] ${kindLabel} · ${preset.name}`,
    greeting,
    frequency: preset.bot_frequency || 'daily',
    weekday: preset.bot_weekday ?? 1,
    sendTime: preset.bot_send_time || '08:00',
    templateId: preset.bot_template_id || existing?.template_id || '',
    active: true,
    defaultValues,
    questions: questions.map((item) => ({
      ...item,
      id: existing?.questions.find((q) => q.export_field === item.exportField)?.id,
    })),
    contactIds,
    sourcePresetId: preset.id,
    formKind: preset.kind,
    companyOdooId: preset.company_odoo_id,
  });

  // Ciclos abertos do dia passam a usar a revisão nova (senão ficam só com perguntas antigas).
  const latestRevision = await one<{ id: string }>(
    `SELECT id FROM questionnaire_revisions
     WHERE questionnaire_id = $1 ORDER BY version DESC LIMIT 1`,
    [questionnaireId],
  );
  if (latestRevision) {
    await run(
      `UPDATE questionnaire_cycles
       SET revision_id = $2, updated_at = $3
       WHERE questionnaire_id = $1 AND status IN ('open', 'notified', 'in_progress')`,
      [questionnaireId, latestRevision.id, new Date().toISOString()],
    );
  }
  return saved;
}

export type FormsBotActivity = {
  sends: Array<{
    id: string;
    at: string;
    status: string;
    phone: string;
    kind: string;
    preview: string;
    error: string;
    cycle_status: string;
    contact_name: string;
  }>;
  answers: Array<{
    at: string;
    contact_name: string;
    contact_phone: string;
    question: string;
    answer: string;
    cycle_status: string;
    occurrence_date: string;
  }>;
};

/** Últimos envios e respostas do questionário ligado ao padrão. */
export async function listFormsBotPresetActivity(presetId: string): Promise<FormsBotActivity> {
  const questionnaireId = formsBotQuestionnaireId(presetId);
  const sends = await many<{
    id: string;
    created_at: string;
    status: string;
    phone: string;
    kind: string;
    text: string;
    error: string;
    cycle_status: string;
    contact_name: string;
  }>(
    `SELECT o.id, o.created_at::text AS created_at, o.status, o.phone, o.kind,
            LEFT(o.text, 160) AS text, COALESCE(o.error, '') AS error,
            COALESCE(cyc.status, '') AS cycle_status,
            COALESCE(ct.name, '') AS contact_name
     FROM outbound_outbox o
     LEFT JOIN questionnaire_cycles cyc ON cyc.id = o.cycle_id
     LEFT JOIN contacts ct ON ct.id = o.contact_id
     WHERE o.cycle_id IN (
       SELECT id FROM questionnaire_cycles WHERE questionnaire_id = $1
     )
        OR (o.raw_json LIKE $2)
     ORDER BY o.created_at DESC
     LIMIT 20`,
    [questionnaireId, `%"presetId":"${presetId}"%`],
  );

  const answers = await many<{
    answered_at: string;
    contact_name: string;
    contact_phone: string;
    question_body: string;
    answer_text: string;
    cycle_status: string;
    occurrence_date: string;
  }>(
    `SELECT COALESCE(ans.updated_at, ans.created_at, '') AS answered_at,
            COALESCE(ct.name, '') AS contact_name,
            COALESCE(ct.phone, '') AS contact_phone,
            COALESCE(qq.body, '') AS question_body,
            COALESCE(ans.answer_text, '') AS answer_text,
            cyc.status AS cycle_status,
            cyc.occurrence_date
     FROM questionnaire_cycles cyc
     JOIN contacts ct ON ct.id = cyc.contact_id
     JOIN questionnaire_answers ans ON ans.cycle_id = cyc.id
     LEFT JOIN questionnaire_questions qq ON qq.id = ans.question_id
     WHERE cyc.questionnaire_id = $1
       AND COALESCE(ans.answer_text, '') <> ''
     ORDER BY COALESCE(ans.updated_at, ans.created_at) DESC
     LIMIT 30`,
    [questionnaireId],
  );

  return {
    sends: sends.map((row) => ({
      id: row.id,
      at: row.created_at,
      status: row.status,
      phone: row.phone,
      kind: row.kind,
      preview: row.text || '',
      error: row.error || '',
      cycle_status: row.cycle_status || '',
      contact_name: row.contact_name || '',
    })),
    answers: answers.map((row) => ({
      at: row.answered_at,
      contact_name: row.contact_name,
      contact_phone: row.contact_phone,
      question: row.question_body,
      answer: row.answer_text,
      cycle_status: row.cycle_status,
      occurrence_date: row.occurrence_date,
    })),
  };
}

async function resolveHeaderValues(input: {
  kind: FormKind;
  companyOdooId: string;
  defaults: Record<string, string>;
  answersByField: Record<string, string>;
}): Promise<Record<string, string>> {
  const header: Record<string, string> = { ...input.defaults };
  for (const [key, raw] of Object.entries(input.answersByField)) {
    if (key === FORMS_BOT_LINES_FIELD) continue;
    if (!headerFieldsFor(input.kind).some((field) => field.key === key)) continue;
    const resolved = await resolveCatalogValue({
      kind: input.kind,
      fieldKey: key,
      raw,
      companyOdooId: input.companyOdooId,
    });
    header[key] = resolved.value;
  }
  return header;
}

async function resolveLineValues(input: {
  kind: FormKind;
  companyOdooId: string;
  lines: Array<Record<string, string>>;
  visibleKeys: string[];
}): Promise<Array<{ values: Record<string, string> }>> {
  const out: Array<{ values: Record<string, string> }> = [];
  for (const line of input.lines) {
    const values: Record<string, string> = {};
    for (const key of input.visibleKeys) {
      const resolved = await resolveCatalogValue({
        kind: input.kind,
        fieldKey: key,
        raw: line[key] || '',
        companyOdooId: input.companyOdooId,
      });
      values[key] = resolved.value;
    }
    if (Object.values(values).some((value) => value.trim())) {
      out.push({ values });
    }
  }
  return out;
}

export async function materializeFormsFromCycle(cycleId: string): Promise<FormDocument | null> {
  const cycle = await one<{
    id: string;
    questionnaire_id: string;
    status: string;
  }>(`SELECT id, questionnaire_id, status FROM questionnaire_cycles WHERE id = $1`, [cycleId]);
  if (!cycle) return null;

  const questionnaire = await getQuestionnaire(cycle.questionnaire_id, true);
  if (!questionnaire?.sourcePresetId || !questionnaire.formKind || !isFormKind(questionnaire.formKind)) {
    return null;
  }

  // Ciclo reaberto (“Enviar agora”) ou corrigido após concluir: atualiza o doc do ciclo
  // em vez de descartar as novas respostas em silêncio.
  const existingDoc = await one<{ id: string }>(
    `SELECT id FROM forms_documents
     WHERE header_json LIKE $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [`%"source_cycle_id":"${cycleId}"%`],
  );

  const preset = await getFormPresetById(questionnaire.sourcePresetId);
  if (!preset) {
    console.warn(`forms-bot: preset ${questionnaire.sourcePresetId} não encontrado (ciclo ${cycleId})`);
    return null;
  }

  const kind = questionnaire.formKind;
  const companyOdooId = questionnaire.companyOdooId || preset.company_odoo_id;
  const answers = await listCycleAnswers(cycleId);
  const answersByField: Record<string, string> = {};
  for (const question of questionnaire.questions) {
    const answer = answers.find((row) => row.question_id === question.id);
    const text = String(answer?.answer_text || '').trim();
    if (!text || isUnusableQuestionnaireAnswer(text)) continue;
    answersByField[question.export_field || ''] = text;
  }

  const defaults = { ...(questionnaire.defaultValues || {}) };
  for (const [key, value] of Object.entries(preset.header || {})) {
    if (String(value || '').trim()) defaults[key] = String(value);
  }

  const header = await resolveHeaderValues({
    kind,
    companyOdooId,
    defaults,
    answersByField,
  });
  // Não cria Forms com fornecedor/cliente inválido (saudação, pedido de lista, etc.).
  if (kind === 'purchase' && isUnusableQuestionnaireAnswer(header.vendor || '')) {
    console.warn(`forms-bot: ciclo ${cycleId} sem fornecedor válido — não materializa`);
    return null;
  }
  if (kind === 'sale' && isUnusableQuestionnaireAnswer(header.customer || '')) {
    console.warn(`forms-bot: ciclo ${cycleId} sem cliente válido — não materializa`);
    return null;
  }
  header.source = 'bot';
  header.source_cycle_id = cycleId;
  header.source_preset_id = questionnaire.sourcePresetId;

  const visibleLineKeys = preset.visible.lines?.length
    ? preset.visible.lines
    : lineFieldsFor(kind).map((field) => field.key);

  const plan = planBotLines({
    kind,
    presetLines: preset.lines || [],
    visibleLineKeys,
    linesAnswer: answersByField[FORMS_BOT_LINES_FIELD] || '',
    moreAnswer: answersByField[FORMS_BOT_LINES_MORE_FIELD] || '',
  });
  let lines = plan.resolvePrimary
    ? await resolveLineValues({ kind, companyOdooId, lines: plan.primary, visibleKeys: plan.primaryKeys })
    : plan.primary.map((values) => ({ values }));
  if (plan.extra.length) {
    const extra = await resolveLineValues({
      kind,
      companyOdooId,
      lines: plan.extra,
      visibleKeys: plan.extraKeys,
    });
    lines = [...lines, ...extra];
  }

  const title = (preset.title || '').trim() || documentTitle(kind, header);
  // A empresa viaja com o documento (company_odoo_id) — saveFormDocument/syncSharedCatalog
  // usam a do próprio doc, sem tocar na empresa “ativa” do painel.
  const docId = existingDoc?.id || (await createFormDocument(kind, { companyOdooId })).id;
  const saved = await saveFormDocument(docId, {
    title,
    status: existingDoc ? undefined : preset.status || 'draft',
    header,
    lines: kind === 'product' ? undefined : lines.length ? lines : [{ values: {} }],
  });
  await markDocSyncPending(saved.id);
  scheduleOdooPush(saved.id);
  if (existingDoc) console.log(`forms-bot: doc ${saved.id} atualizado a partir do ciclo ${cycleId}`);
  return saved;
}

export async function sendFormsBotPresetNow(input: {
  presetId: string;
}): Promise<{ cycleId: string; phone: string; documentHint: string }> {
  let preset = await getFormPreset(input.presetId);
  if (!preset) throw new Error('Padrão não encontrado');
  if (!preset.bot_enabled) {
    preset = await updateFormPreset(preset.id, { bot_enabled: true });
  }

  const recipient = await resolvePresetBotContact(preset);
  const questionnaire = await syncFormsBotQuestionnaire(preset);
  if (!questionnaire) throw new Error('Não foi possível preparar o questionário do Bot');

  const contactId = recipient.id;
  const phone = recipient.phone;
  await run(
    `INSERT INTO questionnaire_assignments(questionnaire_id, contact_id, created_at)
     VALUES($1, $2, $3) ON CONFLICT DO NOTHING`,
    [questionnaire.id, contactId, new Date().toISOString()],
  );

  const clock = zonedNow();
  // Reenvio manual abre ciclo novo: o anterior fica no histórico (superseded_at).
  const cycle = await openFreshCycle(questionnaire.id, contactId, clock.date);
  try {
    const { unskipFormsBotQuestionnaire } = await import('./forms-bot-agenda.js');
    await unskipFormsBotQuestionnaire(contactId, clock.date, questionnaire.id);
  } catch {
    /* agenda opcional */
  }
  await run(
    `UPDATE conversation_questionnaire_context
     SET active_cycle_id = $2, candidate_cycle_ids_json = '[]', awaiting_selection = 0, updated_at = $3
     WHERE conversation_id IN (
       SELECT id FROM conversations WHERE contact_id = $1
     )`,
    [contactId, cycle.id, new Date().toISOString()],
  );

  const name = recipient.name || phone;
  const channelId = getSetting('nevoa_channel_id');
  if (!channelId) throw new Error('Canal WhatsApp (Névoa) não configurado');

  const greeting = (questionnaire.greeting || QUESTIONNAIRE_FIRST_CONTACT_PHRASE)
    .replace(/\{\{\s*1\s*\}\}/g, name)
    .replace(/\{\{nome\}\}/gi, name)
    .trim();
  const { buildFormsBotGuidedInvite } = await import('./forms-bot-catalog-context.js');
  const text = await buildFormsBotGuidedInvite({ greeting, questionnaire });

  const windowOpen = await hasOpenCustomerWindow(contactId, phone);
  const alreadyStarted = (await listCycleAnswers(cycle.id)).length > 0;
  // Fora da janela de 24h (e sem respostas parciais): template Meta abre a conversa.
  if (!windowOpen && !alreadyStarted) {
    const template = await resolveFirstContactTemplate(
      channelId,
      preset.bot_template_id || questionnaire.template_id || '',
    );
    if (!template) {
      throw new Error(
        'Janela de 24h fechada. Configure um template Meta APPROVED neste padrão (ou em Configurações).',
      );
    }
    const preview =
      template.body.replace(/\{\{\s*1\s*\}\}/g, name) || greeting || template.name;
    await enqueueOutbound({
      dedupeKey: `forms-bot:${cycle.id}:manual-template:${Date.now()}`,
      kind: 'template',
      variables: variablesFor(template.body, name),
      templateId: template.id,
      phone,
      text: preview,
      channelId,
      contactId,
      cycleId: cycle.id,
      origin: 'scheduled',
      raw: {
        source: 'forms-bot-manual-template',
        questionnaireId: questionnaire.id,
        presetId: preset.id,
        cycleId: cycle.id,
        windowOpen: false,
        templateId: template.id,
      },
    });
  } else {
    await enqueueOutbound({
      dedupeKey: `forms-bot:${cycle.id}:manual:${Date.now()}`,
      kind: 'text',
      phone,
      text,
      channelId,
      contactId,
      cycleId: cycle.id,
      origin: 'scheduled',
      raw: {
        source: 'forms-bot-manual',
        questionnaireId: questionnaire.id,
        presetId: preset.id,
        cycleId: cycle.id,
        windowOpen,
      },
    });
  }
  await markCycleNotified(cycle.id);
  await rememberCyclePrompt(cycle.id, questionnaire.questions[0]?.id || '', 'envio manual');

  return {
    cycleId: cycle.id,
    phone,
    documentHint: KIND_LABELS[preset.kind],
  };
}

/** Usado por markCycleCompleted — ignora ciclos sem preset Forms. */
export async function onQuestionnaireCycleCompleted(cycleId: string): Promise<void> {
  try {
    await materializeFormsFromCycle(cycleId);
  } catch (error) {
    console.error(
      'forms-bot: falha ao materializar Forms',
      cycleId,
      error instanceof Error ? error.message : error,
    );
  }
}

export type { CycleAnswer };
