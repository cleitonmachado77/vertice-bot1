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
import { saveCost } from './agro-costs.js';
import { listPlantings, type AgroPlanting, type AgroProduct } from './agro-model.js';
import { deleteAgroPreset, getAgroPresetById, type AgroPreset } from './agro-presets.js';
import { enqueueOutbound } from './outbound-outbox.js';
import { normalizeWhatsappPhone } from './phone.js';
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
  const saved = await upsertQuestionnaire({
    id: questionnaireId,
    name: `[Agro] ${AGRO_BOT_LABELS[preset.kind]} · ${preset.name}`,
    greeting: `Oi {{1}}! ${AGRO_BOT_LABELS[preset.kind]} — ${preset.name}`,
    frequency: preset.bot_frequency === 'weekly' ? 'weekly' : preset.bot_frequency,
    weekday: preset.bot_weekday,
    sendTime: preset.bot_send_time,
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
  if (preset.kind === 'agro_custo') await saveCostFromBot(preset.company_odoo_id, values, today);
}

/** Materializa e, se falhar, avisa o contato no WhatsApp com o motivo. */
export async function materializeAgroFromCycleNotifying(cycleId: string): Promise<void> {
  try {
    await materializeAgroFromCycle(cycleId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('agro-bot: falha ao materializar Agro', cycleId, message);
    await notifyAgroMaterializeFailure(cycleId, message).catch((notifyError) => {
      console.error(
        'agro-bot: falha ao avisar materialização',
        cycleId,
        notifyError instanceof Error ? notifyError.message : notifyError,
      );
    });
    throw error;
  }
}

async function notifyAgroMaterializeFailure(cycleId: string, reason: string): Promise<void> {
  const cycle = await one<{ contact_id: string; questionnaire_id: string }>(
    `SELECT contact_id, questionnaire_id FROM questionnaire_cycles WHERE id = $1`,
    [cycleId],
  );
  if (!cycle?.contact_id) return;
  const contact = await getContact(cycle.contact_id);
  if (!contact || Number(contact.hidden) === 1) return;
  const phone = normalizeWhatsappPhone(contact.phone || '');
  if (!phone) return;
  const channelId = getSetting('nevoa_channel_id');
  if (!channelId) return;
  const questionnaire = await getQuestionnaire(cycle.questionnaire_id, true);
  const title = questionnaire?.name || 'lançamento Agro';
  const text = [
    `Não consegui registrar *${title}* no painel.`,
    '',
    `Motivo: ${reason}`,
    '',
    'Confira a sigla do produto e o código da área (talhão) cadastrados no Agro e envie de novo, ou fale com o suporte.',
  ].join('\n');
  await enqueueOutbound({
    dedupeKey: `agro-bot:materialize-fail:${cycleId}`,
    kind: 'text',
    phone,
    text,
    channelId,
    contactId: contact.id,
    cycleId,
    origin: 'agent',
    raw: { source: 'agro-bot-materialize-fail', cycleId, reason },
  });
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCatalogProduct(products: AgroProduct[], raw: string): AgroProduct | undefined {
  const needle = fold(raw);
  if (!needle) return undefined;
  const exact = products.find(
    (item) => fold(item.name) === needle || fold(item.sigla || '') === needle,
  );
  if (exact) return exact;
  return products.find(
    (item) =>
      (item.sigla && fold(item.sigla) === needle) ||
      fold(item.name).includes(needle) ||
      (item.sigla && needle.includes(fold(item.sigla))),
  );
}

function plotMatches(planting: AgroPlanting, plotRaw: string): boolean {
  const needle = fold(plotRaw);
  if (!needle) return true;
  const code = fold(planting.plotName.split('·')[0] || planting.plotName);
  const full = fold(planting.plotName);
  return code === needle || full === needle || full.includes(needle) || needle.includes(code);
}

function pickPlanting(
  plantings: AgroPlanting[],
  values: { productName?: string; plotName?: string; planting?: string },
  products: AgroProduct[],
): AgroPlanting {
  const pool = plantings.filter((item) => item.status !== 'colhido');
  const source = pool.length ? pool : plantings;
  const product = findCatalogProduct(products, values.productName || '');
  const productNeedle = fold(values.productName || '');
  const plotNeedle = fold(values.plotName || '');
  const legacy = fold(values.planting || '');

  let hits = source;
  if (product || productNeedle) {
    hits = hits.filter((item) => {
      if (product && item.productId === product.id) return true;
      const name = fold(item.productName);
      const sigla = fold(product?.sigla || '');
      return (
        name === productNeedle ||
        (sigla && name.includes(sigla)) ||
        (productNeedle && name.includes(productNeedle)) ||
        (sigla && productNeedle === sigla)
      );
    });
  }
  if (plotNeedle) hits = hits.filter((item) => plotMatches(item, plotNeedle));
  if (!hits.length && legacy) {
    hits = source.filter((item) => {
      const hay = fold(`${item.propertyName} ${item.plotName} ${item.productName}`);
      return hay.includes(legacy) || legacy.includes(fold(item.productName));
    });
  }
  if (!hits.length) {
    if (!productNeedle && !plotNeedle && !legacy && source.length === 1) return source[0];
    const hint = [productNeedle && `produto "${values.productName}"`, plotNeedle && `área "${values.plotName}"`]
      .filter(Boolean)
      .join(' e ');
    throw new Error(
      hint
        ? `Plantio não encontrado para ${hint}. Cadastre o plantio/talhão no Agro ou use a sigla e o código corretos.`
        : 'Plantio não encontrado para produto/área informados',
    );
  }
  if (hits.length > 1 && !plotNeedle) {
    // Prefer exact product match; if still many, require area.
    const exact = product ? hits.filter((item) => item.productId === product.id) : hits;
    if (exact.length === 1) return exact[0];
    throw new Error('Há mais de um plantio. Informe também a área (ex.: 1 ou A1)');
  }
  return hits[0];
}

async function findPlotByCode(
  companyId: string,
  plotCode: string,
): Promise<{ id: string; propertyId: string; area: number | null } | undefined> {
  const code = String(plotCode || '').trim();
  if (!code) return undefined;
  return one<{ id: string; propertyId: string; area: number | null }>(
    `SELECT pl.id, pl.property_id AS "propertyId", pl.area
     FROM agro_plots pl
     JOIN agro_properties pr ON pr.id = pl.property_id
     WHERE pr.company_odoo_id = $1 AND pl.active = 1 AND pr.active = 1
       AND (lower(pl.code) = lower($2) OR lower(pl.name) = lower($2))
     ORDER BY lower(pl.code) ASC
     LIMIT 1`,
    [companyId, code],
  );
}

/** Se não houver plantio aberto, cria um a partir do produto + talhão já cadastrados. */
async function resolvePlantingForHarvest(
  companyId: string,
  values: Record<string, string>,
  products: AgroProduct[],
  today: string,
): Promise<AgroPlanting> {
  const plantings = await listPlantings(companyId);
  try {
    return pickPlanting(plantings, values, products);
  } catch (error) {
    const product = findCatalogProduct(products, values.productName || '');
    if (!product) {
      throw new Error(
        `Produto "${values.productName || ''}" não encontrado no catálogo. Use a sigla cadastrada (ex.: ABA, INH).`,
      );
    }
    const plotCode = String(values.plotName || '').trim();
    if (!plotCode) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    const plot = await findPlotByCode(companyId, plotCode);
    if (!plot) {
      throw new Error(
        `Área "${plotCode}" não encontrada. Cadastre o talhão em Configurações Agro antes da colheita.`,
      );
    }
    const plantedOn = agroAnswerDate(values.harvestedOn || '', today);
    return savePlanting(companyId, {
      propertyId: plot.propertyId,
      plotId: plot.id,
      productId: product.id,
      productName: product.name,
      unit: product.uom || '',
      plantedOn,
      plantedQty: values.quantity || '',
      notes: 'Criado automaticamente a partir da colheita via Bot',
      status: 'em_colheita',
    });
  }
}

async function savePlantingFromBot(
  companyId: string,
  cycleId: string,
  values: Record<string, string>,
  today: string,
): Promise<void> {
  const catalog = await listAgroCatalog(companyId);
  const named = values.productName || '';
  const product = findCatalogProduct(catalog.products, named);
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
      productId: product?.id || '__custom__',
      productName: product?.name || named,
      unit: values.unit || product?.uom || '',
      plantedOn: agroAnswerDate(values.plantedOn || '', today),
      plantedQty: values.plantedQty || '',
      notes: values.notes || '',
    },
    existing?.id || '',
  );
  await run(`UPDATE agro_plantings SET source_cycle_id = $2 WHERE id = $1`, [saved.id, cycleId]);
}

async function saveHarvestFromBot(
  companyId: string,
  cycleId: string,
  values: Record<string, string>,
  today: string,
): Promise<void> {
  const catalog = await listAgroCatalog(companyId);
  const planting = await resolvePlantingForHarvest(companyId, values, catalog.products, today);
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
  const catalog = await listAgroCatalog(companyId);
  const planting = await resolvePlantingForHarvest(companyId, values, catalog.products, today);
  const named = values.partnerName || '';
  const buyer = catalog.buyers.find((item) => fold(item.name) === fold(named));
  const existing = await one<{ id: string }>(`SELECT id FROM agro_deliveries WHERE source_cycle_id = $1`, [cycleId]);
  const saved = await saveDelivery(
    companyId,
    {
      plantingId: planting.id,
      partnerId: buyer?.id || '__custom__',
      partnerName: named,
      deliveredOn: agroAnswerDate(values.deliveredOn || '', today),
      quantity: values.quantity || '',
      notes: values.notes || '',
    },
    existing?.id || '',
  );
  await run(`UPDATE agro_deliveries SET source_cycle_id = $2 WHERE id = $1`, [saved.id, cycleId]);
}

async function saveCostFromBot(
  companyId: string,
  values: Record<string, string>,
  today: string,
): Promise<void> {
  const plotCode = String(values.plotName || '').trim();
  if (!plotCode) throw new Error('Informe a área (talhão)');
  const plot = await one<{ id: string }>(
    `SELECT pl.id
     FROM agro_plots pl
     JOIN agro_properties pr ON pr.id = pl.property_id
     WHERE pr.company_odoo_id = $1 AND pl.active = 1 AND pr.active = 1
       AND (lower(pl.code) = lower($2) OR lower(pl.name) = lower($2))
     ORDER BY lower(pl.code) ASC
     LIMIT 1`,
    [companyId, plotCode],
  );
  if (!plot) throw new Error(`Área "${plotCode}" não encontrada. Cadastre o talhão em Configurações.`);
  await saveCost(companyId, {
    plotId: plot.id,
    costOn: agroAnswerDate(values.costOn || '', today),
    name: values.name || '',
    quantity: values.quantity || '',
    unitPrice: '',
    notes: values.notes || '',
  });
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
