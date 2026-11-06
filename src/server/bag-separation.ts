import { many, run } from './db.js';
import {
  BAG_SEPARATION_PRESET_ID,
  countsFromAnswer,
  ensureBagMaterials,
  type BagCount,
} from './bag-materials.js';
import { createFormDocument, getFormDocument, saveFormDocument, type FormDocument } from './forms.js';
import { getFormPresetById } from './forms-presets.js';
import { addBagTypeStock } from './odoo-stock-count.js';

/**
 * Um registro local por tipo informado no ciclo.
 * A quantidade soma no tipo do produto Bag, em Unidade.
 */
export async function materializeBagSeparation(input: {
  cycleId: string;
  companyOdooId: string;
  sourcePresetId: string;
  answer: string;
}): Promise<FormDocument | null> {
  const items = countsFromAnswer(input.answer);
  if (!items?.length) {
    console.warn(`forms-bot: ciclo ${input.cycleId} sem quantidade e sigla válidas`);
    return null;
  }

  const existing = await documentsForCycle(input.cycleId);
  let first: FormDocument | null = null;
  for (const item of items) {
    const saved = await saveBagCount({
      item,
      cycleId: input.cycleId,
      companyOdooId: input.companyOdooId,
      sourcePresetId: input.sourcePresetId,
      previous: existing.get(item.code),
    });
    if (!first) first = saved;
  }
  return first;
}

/** Garante o produto Bag e os tipos no Odoo. */
export async function prepareBagSeparation(): Promise<void> {
  const preset = await getFormPresetById(BAG_SEPARATION_PRESET_ID);
  if (!preset) throw new Error('Padrão Separação de Bags não encontrado');
  const header = { ...preset.header, name: '' };
  await run(`UPDATE forms_presets SET header_json = $2, updated_at = NOW() WHERE id = $1`, [
    preset.id,
    JSON.stringify(header),
  ]);
  const updated = await getFormPresetById(preset.id);
  if (!updated) throw new Error('Padrão Separação de Bags não encontrado');
  const { syncFormsBotQuestionnaire } = await import('./forms-bot.js');
  await syncFormsBotQuestionnaire(updated);
  const companyId = Number(updated.company_odoo_id || 0);
  await ensureBagMaterials(companyId);
}

async function saveBagCount(input: {
  item: BagCount;
  cycleId: string;
  companyOdooId: string;
  sourcePresetId: string;
  previous?: FormDocument;
}): Promise<FormDocument> {
  const alreadyApplied = Boolean(input.previous?.header.stock_applied);
  const header: Record<string, string> = {
    name: 'Bag',
    uom: 'Unidade',
    internal_ref: input.item.code,
    bag_type: input.item.code,
    bag_type_name: input.item.name,
    qty_on_hand: input.item.quantity,
    counted_qty: input.item.quantity,
    track_inventory: 'True',
    source: 'bot',
    source_cycle_id: input.cycleId,
    source_preset_id: input.sourcePresetId,
  };
  if (alreadyApplied) header.stock_applied = input.previous?.header.stock_applied || '';
  const companyId = Number(input.companyOdooId || 0);
  if (!alreadyApplied && companyId) {
    try {
      const stock = await addBagTypeStock(companyId, input.item.code, Number(input.item.quantity));
      header.odoo_id = String(stock.templateId);
      header.odoo_variant_id = String(stock.variantId);
      header.qty_on_hand = String(stock.balance);
      header.stock_applied = input.cycleId;
      header.odoo_synced_at = new Date().toISOString();
      header.odoo_sync_error = '';
      header.odoo_sync_pending = '';
    } catch (error) {
      header.odoo_sync_error = error instanceof Error ? error.message : String(error);
      header.odoo_sync_pending = '1';
    }
  }
  const docId =
    input.previous?.id || (await createFormDocument('product', { companyOdooId: input.companyOdooId })).id;
  const saved = await saveFormDocument(docId, {
    title: `${input.item.quantity} ${input.item.code} · Bag`,
    status: input.previous ? undefined : 'draft',
    header,
  });
  return (await getFormDocument(saved.id)) || saved;
}

async function documentsForCycle(cycleId: string): Promise<Map<string, FormDocument>> {
  const rows = await many<{ id: string }>(
    `SELECT id FROM forms_documents
     WHERE kind = 'product' AND header_json LIKE $1
     ORDER BY created_at ASC`,
    [`%"source_cycle_id":"${cycleId}"%`],
  );
  const byCode = new Map<string, FormDocument>();
  for (const row of rows) {
    const doc = await getFormDocument(row.id);
    const code = String(doc?.header.internal_ref || '').trim().toUpperCase();
    if (doc && code) byCode.set(code, doc);
  }
  return byCode;
}
