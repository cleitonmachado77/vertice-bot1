import {
  BAG_MATERIALS,
  ensureBagMaterials,
  findBagMaterial,
  interpretBagCounts,
  materialsForCompany,
  type BagCount,
  type BagMaterial,
  type BagReading,
} from './bag-materials.js';
import { many, run } from './db.js';
import { FARDO_ENTREGA_FIELD, isMarkedNewValue, markNewValue, unmarkNewValue } from './forms-bot-fields.js';
import { createFormDocument, getFormDocument, saveFormDocument, type FormDocument } from './forms.js';
import { getFormPresetById } from './forms-presets.js';
import { addFardoTypeStock } from './odoo-stock-count.js';
import { missingQuestions, type CycleAnswer } from './questionnaire-cycles.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

/** Padrão Entrega de Fardos: registra fardos produzidos sem converter bags. */
export const FARDO_ENTREGA_PRESET_ID = 'a7e2be06-b04f-4c9d-85ee-a8d27630f460';

export const FARDO_ENTREGA_QUESTION = 'Quantos fardos de qual tipo? (ex.: 3 pts)';

export type FardoEntrega = BagCount;

export function isFardoEntregaPreset(preset: { id?: string; kind?: string; name?: string }): boolean {
  if (preset.kind && preset.kind !== 'production') return false;
  if (String(preset.id || '') === FARDO_ENTREGA_PRESET_ID) return true;
  const name = fold(preset.name || '');
  return name.includes('entrega') && name.includes('fardo');
}

/** “3 pts”, “3 fardos pts”, “2 lat, 1 pap”. */
export function interpretFardoEntregas(text: string, materials: BagMaterial[] = BAG_MATERIALS): BagReading {
  const normalized = String(text || '')
    .replace(/\bfardos?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return interpretBagCounts(normalized, materials);
}

export function fardoEntregaClarification(understood: FardoEntrega[], unknown: string[]): string {
  const lines: string[] = [];
  if (understood.length) {
    lines.push('Entendi:', ...understood.map((item) => `- ${item.quantity} fardo ${item.code} (${item.name})`));
  }
  if (unknown.length) {
    if (lines.length) lines.push('');
    lines.push('Não entendi:', ...unknown.map((item) => `- ${item}`));
  }
  lines.push('', 'Corrija o que não entendi. Ex.: 3 pts');
  return lines.join('\n');
}

export function entregasFromAnswer(text: string, companyId?: number): FardoEntrega[] | null {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('[novo?]')) return null;
  const materials = companyId && companyId > 0 ? materialsForCompany(companyId) : BAG_MATERIALS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const items: FardoEntrega[] = [];
      for (const row of parsed) {
        const source = row && typeof row === 'object' ? (row as { code?: string; quantity?: string }) : {};
        const material = findBagMaterial(String(source.code || ''), companyId);
        const quantity = Number(String(source.quantity || '').replace(',', '.'));
        if (!material || !Number.isFinite(quantity) || quantity <= 0) return null;
        items.push({
          code: material.code,
          name: material.name,
          category: material.category,
          quantity: formatQty(quantity),
        });
      }
      return items.length ? mergeEntregas(items) : null;
    }
  } catch {
    /* texto livre */
  }
  const reading = interpretFardoEntregas(raw, materials);
  return reading.understood.length && !reading.unknown.length ? reading.understood : null;
}

export async function answerFardoEntrega(input: {
  inbound: string;
  questionnaire: Questionnaire;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  pendingQuestionId?: string;
}): Promise<
  | { kind: 'reask'; text: string; pendingQuestionId: string }
  | { kind: 'answers'; accepted: { questionId: string; text: string; type: string }[]; summary: string; detail: string }
  | null
> {
  const question = input.questions.find((item) => String(item.export_field || '').trim() === FARDO_ENTREGA_FIELD);
  if (!question) return null;
  const isEntrega =
    String(input.questionnaire.sourcePresetId || '') === FARDO_ENTREGA_PRESET_ID ||
    String(question.body || '').startsWith('Quantos fardos');
  if (!isEntrega) return null;
  const missing = missingQuestions(input.questions, input.alreadySaved);
  if (!missing.some((item) => item.id === question.id)) return null;
  const pendingId = String(input.pendingQuestionId || '').trim();
  const answering = pendingId ? pendingId === question.id : missing[0]?.id === question.id;
  if (!answering) return null;

  const saved = String(input.alreadySaved.find((row) => row.question_id === question.id)?.answer_text || '');
  const materials = materialsForCompany(Number(input.questionnaire.companyOdooId || 0));
  const reading = interpretFardoEntregas(input.inbound, materials);
  const understood = mergeEntregas([...readPartial(saved), ...reading.understood]);
  if (!reading.understood.length && !reading.unknown.length) {
    return {
      kind: 'reask',
      text: fardoEntregaClarification([], ['informe quantos fardos e o tipo. Ex.: 3 pts']),
      pendingQuestionId: question.id,
    };
  }
  if (reading.unknown.length) {
    const text = fardoEntregaClarification(understood, reading.unknown);
    if (!understood.length) return { kind: 'reask', text, pendingQuestionId: question.id };
    return {
      kind: 'answers',
      accepted: [{ questionId: question.id, text: markNewValue(JSON.stringify({ understood })), type: 'text' }],
      summary: text,
      detail: 'entrega de fardos parcial',
    };
  }
  const summary = understood.map((item) => `${item.quantity} fardo ${item.code}`).join(', ');
  return {
    kind: 'answers',
    accepted: [
      {
        questionId: question.id,
        text: JSON.stringify(understood.map((item) => ({ code: item.code, quantity: item.quantity }))),
        type: 'text',
      },
    ],
    summary,
    detail: 'entrega de fardos',
  };
}

/** Push do site (Prensagem · Fardos sem bags): soma estoque do Fardo pela sigla. */
export async function pushFardoEntregaFromDoc(doc: FormDocument): Promise<FormDocument> {
  if (doc.header.stock_applied && String(doc.header.odoo_state || '') === 'done') {
    return doc;
  }
  const companyId = Number(doc.company_odoo_id || doc.header.company_odoo_id || 0);
  if (!companyId) throw new Error('Empresa do Odoo obrigatória para lançar fardos');
  const code = String(doc.header.bag_type || '').trim().toUpperCase();
  const qty = Number(String(doc.header.input_qty || doc.lines?.[0]?.values?.quantity || '').replace(',', '.'));
  if (!code) throw new Error('Informe o tipo do fardo (sigla)');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Informe a quantidade de fardos');

  const header: Record<string, string> = {
    ...doc.header,
    fardo_flow: 'entrega_direta',
    input_product: 'Fardo',
    input_uom: doc.header.input_uom || 'Unidade',
    input_qty: formatQty(qty),
    bag_type: code,
    odoo_sync_pending: '',
    odoo_sync_error: '',
  };
  const stock = await addFardoTypeStock(companyId, code, qty);
  header.odoo_id = String(stock.templateId);
  header.odoo_variant_id = String(stock.variantId);
  header.qty_on_hand = String(stock.balance);
  header.stock_applied = doc.id;
  header.odoo_state = 'done';
  header.odoo_synced_at = new Date().toISOString();

  const lines = [{ values: { product: 'Fardo', quantity: formatQty(qty), uom: 'Unidade' } }];
  const title = doc.title?.trim() || `${formatQty(qty)} fardo ${code}`;
  const saved = await saveFormDocument(doc.id, {
    title,
    status: 'done',
    header,
    lines,
  });
  return (await getFormDocument(saved.id)) || saved;
}

/**
 * Um registro local por tipo: entra Fardo no estoque sem consumir Bag.
 */
export async function materializeFardoEntrega(input: {
  cycleId: string;
  companyOdooId: string;
  sourcePresetId: string;
  occurrenceDate: string;
  answer: string;
}): Promise<FormDocument | null> {
  const items = entregasFromAnswer(input.answer, Number(input.companyOdooId || 0) || undefined);
  if (!items?.length) {
    console.warn(`forms-bot: ciclo ${input.cycleId} sem fardos válidos`);
    return null;
  }
  const existing = await documentsForCycle(input.cycleId);
  let first: FormDocument | null = null;
  for (const item of items) {
    const saved = await saveFardoEntrega({
      item,
      cycleId: input.cycleId,
      companyOdooId: input.companyOdooId,
      sourcePresetId: input.sourcePresetId,
      occurrenceDate: input.occurrenceDate,
      previous: existing.get(item.code),
    });
    if (!first) first = saved;
  }
  return first;
}

/** Cria/atualiza o padrão canônico e sincroniza o questionário do bot. */
export async function prepareFardoEntrega(companyOdooId: string): Promise<void> {
  let preset = await getFormPresetById(FARDO_ENTREGA_PRESET_ID);
  if (!preset) {
    await run(
      `INSERT INTO forms_presets
        (id, company_odoo_id, kind, name, title, status, header_json, lines_json, visible_json,
         bot_enabled, bot_frequency, bot_weekday, bot_send_time, bot_template_id, bot_contact_id,
         bot_also_contact_ids, sort_order, bot_rules_json)
       VALUES ($1, $2, 'production', $3, '', 'draft', $4, '[]', $5,
               0, 'weekdays', 1, '17:00', '', '', '[]', 0, '{}')`,
      [
        FARDO_ENTREGA_PRESET_ID,
        companyOdooId,
        'Entrega de Fardos',
        JSON.stringify({ input_product: 'Fardo', input_qty: '', input_uom: 'Unidade' }),
        JSON.stringify({ title: true, status: false, header: ['input_product', 'input_qty', 'input_uom'], lines: [] }),
      ],
    );
    preset = await getFormPresetById(FARDO_ENTREGA_PRESET_ID);
  } else {
    await run(`UPDATE forms_presets SET name = $2, updated_at = NOW() WHERE id = $1`, [
      FARDO_ENTREGA_PRESET_ID,
      'Entrega de Fardos',
    ]);
    preset = await getFormPresetById(FARDO_ENTREGA_PRESET_ID);
  }
  if (!preset) throw new Error('Padrão Entrega de Fardos não encontrado');
  const { syncFormsBotQuestionnaire } = await import('./forms-bot.js');
  await syncFormsBotQuestionnaire(preset);
  const companyId = Number(preset.company_odoo_id || companyOdooId || 0);
  if (companyId) await ensureBagMaterials(companyId);
}

async function saveFardoEntrega(input: {
  item: FardoEntrega;
  cycleId: string;
  companyOdooId: string;
  sourcePresetId: string;
  occurrenceDate: string;
  previous?: FormDocument;
}): Promise<FormDocument> {
  const header: Record<string, string> = {
    ...(input.previous?.header || {}),
    input_product: 'Fardo',
    input_qty: input.item.quantity,
    input_uom: 'Unidade',
    production_date: input.occurrenceDate || input.previous?.header.production_date || '',
    bag_type: input.item.code,
    bag_type_name: input.item.name,
    source: 'bot',
    source_cycle_id: input.cycleId,
    source_preset_id: input.sourcePresetId,
    fardo_flow: 'entrega_direta',
  };
  if (input.previous?.header.stock_applied) return input.previous;
  const lines = [{ values: { product: 'Fardo', quantity: input.item.quantity, uom: 'Unidade' } }];
  const companyId = Number(input.companyOdooId || 0);
  if (!header.stock_applied && companyId) {
    try {
      const stock = await addFardoTypeStock(companyId, input.item.code, Number(input.item.quantity));
      header.odoo_id = String(stock.templateId);
      header.odoo_variant_id = String(stock.variantId);
      header.qty_on_hand = String(stock.balance);
      header.stock_applied = input.cycleId;
      header.odoo_state = 'done';
      header.odoo_synced_at = new Date().toISOString();
      header.odoo_sync_error = '';
      header.odoo_sync_pending = '';
    } catch (error) {
      header.odoo_sync_error = error instanceof Error ? error.message : String(error);
      header.odoo_sync_pending = '1';
    }
  }
  const docId =
    input.previous?.id || (await createFormDocument('production', { companyOdooId: input.companyOdooId })).id;
  const saved = await saveFormDocument(docId, {
    title: `${input.item.quantity} fardo ${input.item.code}`,
    status: header.odoo_state === 'done' ? 'done' : input.previous ? undefined : 'draft',
    header,
    lines,
  });
  return (await getFormDocument(saved.id)) || saved;
}

async function documentsForCycle(cycleId: string): Promise<Map<string, FormDocument>> {
  const rows = await many<{ id: string }>(
    `SELECT id FROM forms_documents
     WHERE kind = 'production' AND header_json LIKE $1
     ORDER BY created_at ASC`,
    [`%"source_cycle_id":"${cycleId}"%`],
  );
  const byCode = new Map<string, FormDocument>();
  for (const row of rows) {
    const doc = await getFormDocument(row.id);
    const code = String(doc?.header.bag_type || '').trim().toUpperCase();
    if (doc && code) byCode.set(code, doc);
  }
  return byCode;
}

function readPartial(text: string): FardoEntrega[] {
  if (!isMarkedNewValue(text)) return [];
  try {
    const parsed = JSON.parse(unmarkNewValue(text)) as { understood?: FardoEntrega[] };
    return Array.isArray(parsed.understood) ? parsed.understood : [];
  } catch {
    return [];
  }
}

function mergeEntregas(items: FardoEntrega[]): FardoEntrega[] {
  const byCode = new Map<string, FardoEntrega>();
  for (const item of items) {
    const current = byCode.get(item.code);
    if (!current) {
      byCode.set(item.code, { ...item });
      continue;
    }
    current.quantity = formatQty(Number(current.quantity) + Number(item.quantity));
  }
  return [...byCode.values()];
}

function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function fold(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .trim();
}
