import { getSetting, one, run } from './db.js';
import { zonedNow } from './clock.js';
import { listAgroCatalog } from './agro-catalog.js';
import {
  AGRO_BOT_CONFIRM,
  AGRO_BOT_LABELS,
  agroAnswerDate,
  agroAnswerYes,
  agroBotFields,
  isAgroBotKind,
} from './agro-bot-fields.js';
import { saveDelivery, saveHarvest, savePlanting } from './agro.js';
import { listPlantings, type AgroPlanting } from './agro-model.js';
import { deleteAgroPreset, getAgroPresetById, type AgroPreset } from './agro-presets.js';
import { enqueueOutbound } from './outbound-outbox.js';
import { normalizeWhatsappPhone } from './phone.js';
import { formsReminderSchedule } from './forms-reminder.js';
import { CONFIRM_QUESTION_BODY } from './forms-bot-fields.js';
import {
  getQuestionnaire,
  QUESTIONNAIRE_FIRST_CONTACT_PHRASE,
  upsertQuestionnaire,
  type Questionnaire,
} from './questionnaires.js';
import { listCycleAnswers, markCycleNotified, openFreshCycle, rememberCyclePrompt } from './questionnaire-cycles.js';
import { resolveFirstContactTemplate, variablesFor } from './questionnaire-dispatch.js';
import { getContact } from './store.js';
import { hasOpenCustomerWindow } from './thread.js';

export function agroBotQuestionnaireId(presetId: string): string {
  return `agro-preset:${presetId}`;
}

export async function syncAgroBotQuestionnaire(preset: AgroPreset): Promise<Questionnaire | null> {
  const questionnaireId = agroBotQuestionnaireId(preset.id);
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
  const questions = questionsFor(preset);
  if (!questions.length) {
    throw new Error('Deixe algum campo visível sem valor padrão para o Bot perguntar');
  }
  const contact = await resolveContact(preset.bot_contact_id);
  const existing = await getQuestionnaire(questionnaireId, true);
  const schedule = formsReminderSchedule();
  const saved = await upsertQuestionnaire({
    id: questionnaireId,
    name: `[Agro] ${AGRO_BOT_LABELS[preset.kind]} · ${preset.name}`,
    greeting: `Oi {{1}}! ${AGRO_BOT_LABELS[preset.kind]} — ${preset.name}`,
    frequency: schedule.frequency,
    weekday: schedule.weekday,
    sendTime: schedule.sendTime,
    templateId: preset.bot_template_id || existing?.template_id || '',
    active: true,
    defaultValues: defaultsFor(preset),
    questions: questions.map((item) => ({
      ...item,
      id: existing?.questions.find((question) => question.export_field === item.exportField)?.id,
    })),
    contactIds: [contact.id],
    sourcePresetId: preset.id,
    formKind: preset.kind,
    companyOdooId: preset.company_odoo_id,
  });
  return saved;
}

function questionsFor(preset: AgroPreset): Array<{ body: string; expectedType: 'text'; exportField: string }> {
  const visible = new Set(preset.visible);
  const questions = agroBotFields(preset.kind)
    .filter((field) => visible.has(field.key) && !String(preset.header[field.key] || '').trim())
    .map((field) => ({ body: field.body, expectedType: 'text' as const, exportField: field.key }));
  if (preset.bot_rules.confirm_before_close) {
    questions.push({ body: CONFIRM_QUESTION_BODY, expectedType: 'text', exportField: AGRO_BOT_CONFIRM });
  }
  return questions;
}

function defaultsFor(preset: AgroPreset): Record<string, string> {
  const visible = new Set(preset.visible);
  const out: Record<string, string> = {};
  for (const field of agroBotFields(preset.kind)) {
    const value = String(preset.header[field.key] || '').trim();
    if (visible.has(field.key) && value) out[field.key] = value;
  }
  return out;
}

async function resolveContact(contactId: string): Promise<{ id: string; name: string; phone: string }> {
  const contact = await getContact(contactId);
  if (!contact || Number(contact.hidden) === 1) throw new Error('Contato do Bot não encontrado');
  const phone = normalizeWhatsappPhone(contact.phone || '');
  if (!phone) throw new Error('O contato selecionado não tem WhatsApp válido');
  return { id: contact.id, name: contact.name || phone, phone };
}

export async function materializeAgroFromCycle(cycleId: string): Promise<void> {
  const cycle = await one<{ id: string; questionnaire_id: string }>(
    `SELECT id, questionnaire_id FROM questionnaire_cycles WHERE id = $1`,
    [cycleId],
  );
  if (!cycle || !cycle.questionnaire_id.startsWith('agro-preset:')) return;
  const questionnaire = await getQuestionnaire(cycle.questionnaire_id, true);
  if (!questionnaire?.sourcePresetId || !isAgroBotKind(questionnaire.formKind)) return;
  const preset = await getAgroPresetById(questionnaire.sourcePresetId);
  if (!preset) return;
  const answers = await listCycleAnswers(cycleId);
  const values = { ...defaultsFor(preset) };
  for (const answer of answers) {
    const question = questionnaire.questions.find((item) => item.id === answer.question_id);
    const key = String(question?.export_field || '').trim();
    if (!key || key === AGRO_BOT_CONFIRM) continue;
    const text = String(answer.answer_text || '').trim();
    if (text) values[key] = text;
  }
  const today = zonedNow().date;
  if (preset.kind === 'agro_plantio') await savePlantingFromBot(preset.company_odoo_id, cycleId, values, today);
  if (preset.kind === 'agro_colheita') await saveHarvestFromBot(preset.company_odoo_id, cycleId, values, today);
  if (preset.kind === 'agro_entrega') await saveDeliveryFromBot(preset.company_odoo_id, cycleId, values, today);
}

async function savePlantingFromBot(
  companyId: string,
  cycleId: string,
  values: Record<string, string>,
  today: string,
): Promise<void> {
  const catalog = await listAgroCatalog(companyId);
  const named = values.productName || '';
  const product = catalog.products.find((item) => item.name.toLowerCase() === named.toLowerCase());
  const existing = await one<{ id: string }>(
    `SELECT id FROM agro_plantings WHERE source_cycle_id = $1`,
    [cycleId],
  );
  const saved = await savePlanting(
    companyId,
    {
      propertyId: '__new__',
      propertyName: values.propertyName || '',
      producerName: values.producerName || '',
      plotId: '__new__',
      plotName: values.plotName || '',
      plotArea: values.plotArea || '',
      productId: product?.id || '__custom__',
      productName: named,
      unit: values.unit || product?.uom || '',
      areaPlanned: values.areaPlanned || '',
      plantedOn: agroAnswerDate(values.plantedOn || '', today),
      forecastOn: values.forecastOn ? agroAnswerDate(values.forecastOn, today) : '',
      forecastQty: values.forecastQty || '',
      notes: values.notes || '',
    },
    existing?.id || '',
  );
  await run(`UPDATE agro_plantings SET source_cycle_id = $2 WHERE id = $1`, [saved.id, cycleId]);
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickPlanting(plantings: AgroPlanting[], text: string): AgroPlanting {
  const needle = fold(text);
  const pool = plantings.filter((item) => item.status !== 'colhido');
  const source = pool.length ? pool : plantings;
  if (!needle) {
    if (source.length === 1) return source[0];
    throw new Error('Informe a propriedade ou a cultura do plantio');
  }
  const hits = source.filter((item) => {
    const hay = fold(`${item.propertyName} ${item.plotName} ${item.productName}`);
    return hay.includes(needle) || needle.includes(fold(item.productName)) || needle.includes(fold(item.propertyName));
  });
  if (!hits.length) throw new Error('Plantio não encontrado para essa resposta');
  return hits[0];
}

async function saveHarvestFromBot(
  companyId: string,
  cycleId: string,
  values: Record<string, string>,
  today: string,
): Promise<void> {
  const planting = pickPlanting(await listPlantings(companyId), values.planting || '');
  const existing = await one<{ id: string }>(`SELECT id FROM agro_harvests WHERE source_cycle_id = $1`, [cycleId]);
  const saved = await saveHarvest(
    companyId,
    {
      plantingId: planting.id,
      harvestedOn: agroAnswerDate(values.harvestedOn || '', today),
      quantity: values.quantity || '',
      close: agroAnswerYes(values.close || ''),
      notes: values.notes || '',
    },
    existing?.id || '',
  );
  await run(`UPDATE agro_harvests SET source_cycle_id = $2 WHERE id = $1`, [saved.id, cycleId]);
}

async function saveDeliveryFromBot(
  companyId: string,
  cycleId: string,
  values: Record<string, string>,
  today: string,
): Promise<void> {
  const planting = pickPlanting(await listPlantings(companyId), values.planting || '');
  const catalog = await listAgroCatalog(companyId);
  const named = values.partnerName || '';
  const buyer = catalog.buyers.find((item) => item.name.toLowerCase() === named.toLowerCase());
  const existing = await one<{ id: string }>(`SELECT id FROM agro_deliveries WHERE source_cycle_id = $1`, [cycleId]);
  const saved = await saveDelivery(
    companyId,
    {
      plantingId: planting.id,
      partnerId: buyer?.id || '__custom__',
      partnerName: named,
      deliveredOn: agroAnswerDate(values.deliveredOn || '', today),
      quantity: values.quantity || '',
      unitPrice: values.unitPrice || '',
      document: values.document || '',
      notes: values.notes || '',
    },
    existing?.id || '',
  );
  await run(`UPDATE agro_deliveries SET source_cycle_id = $2 WHERE id = $1`, [saved.id, cycleId]);
}

export async function sendAgroBotPresetNow(companyId: string, presetId: string): Promise<{ phone: string }> {
  const { getAgroPreset, saveAgroPreset } = await import('./agro-presets.js');
  let preset = await getAgroPreset(companyId, presetId);
  if (!preset) throw new Error('Padrão não encontrado');
  if (!preset.bot_enabled) preset = await saveAgroPreset(companyId, { ...preset, bot_enabled: true }, preset.id);
  const contact = await resolveContact(preset.bot_contact_id);
  const questionnaire = await syncAgroBotQuestionnaire(preset);
  if (!questionnaire) throw new Error('Não foi possível preparar o questionário do Bot');
  const clock = zonedNow();
  const cycle = await openFreshCycle(questionnaire.id, contact.id, clock.date);
  const channelId = getSetting('nevoa_channel_id');
  if (!channelId) throw new Error('Canal WhatsApp (Névoa) não configurado');
  const greeting = (questionnaire.greeting || QUESTIONNAIRE_FIRST_CONTACT_PHRASE)
    .replace(/\{\{\s*1\s*\}\}/g, contact.name)
    .trim();
  const windowOpen = await hasOpenCustomerWindow(contact.id, contact.phone);
  if (!windowOpen) {
    const template = await resolveFirstContactTemplate(channelId, preset.bot_template_id || questionnaire.template_id || '');
    if (!template) {
      throw new Error('Janela de 24h fechada. Configure um template Meta APPROVED neste padrão (ou em Configurações).');
    }
    await enqueueOutbound({
      dedupeKey: `agro-bot:${cycle.id}:manual-template:${Date.now()}`,
      kind: 'template',
      variables: variablesFor(template.body, contact.name),
      templateId: template.id,
      phone: contact.phone,
      text: template.body.replace(/\{\{\s*1\s*\}\}/g, contact.name) || greeting,
      channelId,
      contactId: contact.id,
      cycleId: cycle.id,
      origin: 'scheduled',
      raw: { source: 'agro-bot-manual-template', presetId: preset.id, cycleId: cycle.id },
    });
  } else {
    await enqueueOutbound({
      dedupeKey: `agro-bot:${cycle.id}:manual:${Date.now()}`,
      kind: 'text',
      phone: contact.phone,
      text: `${greeting}\n\n${questionnaire.questions[0]?.body || ''}`.trim(),
      channelId,
      contactId: contact.id,
      cycleId: cycle.id,
      origin: 'scheduled',
      raw: { source: 'agro-bot-manual', presetId: preset.id, cycleId: cycle.id },
    });
  }
  await markCycleNotified(cycle.id);
  await rememberCyclePrompt(cycle.id, questionnaire.questions[0]?.id || '', 'envio manual agro');
  return { phone: contact.phone };
}

export async function removeAgroPreset(companyId: string, id: string): Promise<void> {
  const questionnaireId = agroBotQuestionnaireId(id);
  await deleteAgroPreset(companyId, id);
  await run(
    `UPDATE questionnaires SET active = 0, deleted_at = $2, updated_at = $2 WHERE id = $1`,
    [questionnaireId, new Date().toISOString()],
  );
}
