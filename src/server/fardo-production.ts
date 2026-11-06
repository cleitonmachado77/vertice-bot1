import { many } from './db.js';
import { bagVariantRef, ensureBagMaterials, fardoVariantRef } from './bag-materials.js';
import { runsFromAnswer, type FardoRun } from './fardo-counts.js';
import { createFormDocument, getFormDocument, saveFormDocument, type FormDocument } from './forms.js';
import { getFormPresetById } from './forms-presets.js';
import { odooCreate, odooExecuteKw, odooSearchRead } from './odoo-client.js';
import { productQtyAvailable } from './odoo-production.js';

/**
 * Uma ordem de fabricação por tipo: consome o Bag da sigla e produz o Fardo da mesma sigla.
 * Os dois produtos estão em Unidade. A ordem já vai concluída.
 */
export async function materializeFardoProduction(input: {
  cycleId: string;
  companyOdooId: string;
  sourcePresetId: string;
  occurrenceDate: string;
  answer: string;
}): Promise<FormDocument | null> {
  const items = runsFromAnswer(input.answer);
  if (!items?.length) {
    console.warn(`forms-bot: ciclo ${input.cycleId} sem bags e fardos do mesmo tipo`);
    return null;
  }
  const existing = await documentsForCycle(input.cycleId);
  let first: FormDocument | null = null;
  for (const item of items) {
    const saved = await saveFardoRun({
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

/** Atualiza a pergunta do padrão e garante Bag e Fardo no Odoo. */
export async function prepareFardoProduction(): Promise<void> {
  const preset = await getFormPresetById('be8a792d-97e5-4d71-a54d-c3e51e667ed5');
  if (!preset) throw new Error('Padrão Produção de Fardos não encontrado');
  const { run } = await import('./db.js');
  const header = { ...preset.header, input_product: 'Bag', input_qty: '', input_uom: 'Unidade' };
  await run(`UPDATE forms_presets SET header_json = $2, updated_at = NOW() WHERE id = $1`, [
    preset.id,
    JSON.stringify(header),
  ]);
  const updated = await getFormPresetById(preset.id);
  if (!updated) throw new Error('Padrão Produção de Fardos não encontrado');
  const { syncFormsBotQuestionnaire } = await import('./forms-bot.js');
  await syncFormsBotQuestionnaire(updated);
  const companyId = Number(updated.company_odoo_id || 0);
  if (companyId) await ensureBagMaterials(companyId);
}

async function saveFardoRun(input: {
  item: FardoRun;
  cycleId: string;
  companyOdooId: string;
  sourcePresetId: string;
  occurrenceDate: string;
  previous?: FormDocument;
}): Promise<FormDocument> {
  const header: Record<string, string> = {
    ...(input.previous?.header || {}),
    input_product: 'Bag',
    input_qty: input.item.bags,
    input_uom: 'Unidade',
    production_date: input.occurrenceDate || input.previous?.header.production_date || '',
    bag_type: input.item.code,
    bag_type_name: input.item.name,
    source: 'bot',
    source_cycle_id: input.cycleId,
    source_preset_id: input.sourcePresetId,
  };
  if (input.previous?.header.stock_applied) return input.previous;
  const lines = [{ values: { product: 'Fardo', quantity: input.item.fardos, uom: 'Unidade' } }];
  const companyId = Number(input.companyOdooId || 0);
  if (!header.stock_applied && companyId) {
    try {
      const order = await registerFardoOrder({
        companyId,
        code: input.item.code,
        bags: Number(input.item.bags),
        fardos: Number(input.item.fardos),
        occurrenceDate: header.production_date,
        existingId: Number(header.odoo_id || 0),
      });
      header.odoo_id = String(order.id);
      header.order_reference = order.name;
      header.odoo_state = order.state;
      header.odoo_variant_id = String(order.fardoVariantId);
      header.stock_warning = order.warning;
      header.stock_applied = input.cycleId;
      header.odoo_synced_at = new Date().toISOString();
      header.odoo_sync_error = '';
      header.odoo_sync_pending = '';
    } catch (error) {
      header.odoo_sync_error = error instanceof Error ? error.message : String(error);
      header.odoo_sync_pending = '1';
    }
  }
  const docId = input.previous?.id || (await createFormDocument('production', { companyOdooId: input.companyOdooId })).id;
  const saved = await saveFormDocument(docId, {
    title: `${input.item.bags} ${input.item.code} → ${input.item.fardos} fardo`,
    status: header.odoo_state === 'done' ? 'done' : input.previous ? undefined : 'draft',
    header,
    lines,
  });
  return (await getFormDocument(saved.id)) || saved;
}

async function registerFardoOrder(input: {
  companyId: number;
  code: string;
  bags: number;
  fardos: number;
  occurrenceDate: string;
  existingId: number;
}): Promise<{ id: number; name: string; state: string; fardoVariantId: number; warning: string }> {
  if (!bagVariantRef(input.companyId, input.code) || !fardoVariantRef(input.companyId, input.code)) {
    await ensureBagMaterials(input.companyId);
  }
  const bag = bagVariantRef(input.companyId, input.code);
  const fardo = fardoVariantRef(input.companyId, input.code);
  if (!bag || !fardo) throw new Error(`Tipo ${input.code} não está no Bag e no Fardo`);
  const uomId = await unitId();
  if (!uomId) throw new Error('Cadastre a unidade de medida Unidade no Odoo');
  const context = { allowed_company_ids: [input.companyId], force_company: input.companyId };
  let mo = input.existingId > 0 ? await readMo(input.existingId) : undefined;
  if (mo && (mo.state === 'done' || mo.state === 'cancel')) {
    return { id: mo.id, name: mo.name, state: mo.state, fardoVariantId: fardo.variantId, warning: '' };
  }
  if (!mo) {
    const [picking] = await odooSearchRead<{ id: number }>(
      'stock.picking.type',
      [['code', '=', 'mrp_operation'], ['company_id', '=', input.companyId]],
      ['id'],
      { limit: 1 },
    );
    if (!picking?.id) throw new Error(`Empresa Odoo ${input.companyId} sem operação de Fabricação`);
    const values: Record<string, unknown> = {
      product_id: fardo.variantId,
      product_qty: input.fardos,
      uom_id: uomId,
      company_id: input.companyId,
      picking_type_id: picking.id,
      origin: 'Vertice',
    };
    if (/^\d{4}-\d{2}-\d{2}/.test(input.occurrenceDate)) values.date_start = `${input.occurrenceDate.slice(0, 10)} 12:00:00`;
    const id = await odooCreate('mrp.production', values, { context });
    mo = await readMo(id);
    if (!mo) throw new Error('Ordem de fardos criada, mas não encontrada no Odoo');
    await odooCreate(
      'stock.move',
      {
        raw_material_production_id: mo.id,
        product_id: bag.variantId,
        product_uom_qty: input.bags,
        uom_id: uomId,
        location_id: many2oneId(mo.location_src_id),
        location_dest_id: many2oneId(mo.production_location_id),
        company_id: input.companyId,
      },
      { context },
    );
  }
  const stock = await productQtyAvailable(bag.variantId, input.companyId);
  const warning = stock < input.bags
    ? `Estoque de Bag ${input.code} insuficiente: havia ${stock} Unidade e a ordem consumiu ${input.bags}.`
    : '';
  if (mo.state === 'draft') await odooExecuteKw('mrp.production', 'action_confirm', [[mo.id]], { context });
  await odooExecuteKw('mrp.production', 'button_mark_done', [[mo.id]], {
    context: { ...context, skip_consumption: true, skip_backorder: true, mo_ids_to_backorder: [] },
  });
  const after = (await readMo(mo.id)) || mo;
  if (after.state !== 'done') throw new Error(`Ordem ${after.name} não foi concluída no Odoo: estado ${after.state}`);
  return { id: after.id, name: after.name, state: after.state, fardoVariantId: fardo.variantId, warning };
}

type MoRow = {
  id: number;
  name: string;
  state: string;
  location_src_id: unknown;
  production_location_id: unknown;
};

async function readMo(id: number): Promise<MoRow | undefined> {
  const [row] = await odooSearchRead<MoRow>(
    'mrp.production',
    [['id', '=', id]],
    ['id', 'name', 'state', 'location_src_id', 'production_location_id'],
    { limit: 1 },
  );
  return row;
}

async function unitId(): Promise<number> {
  const rows = await odooSearchRead<{ id: number; relative_uom_id: unknown }>(
    'uom.uom',
    [['name', '=', 'Unidade']],
    ['relative_uom_id'],
    { limit: 5 },
  );
  return rows.find((row) => !row.relative_uom_id)?.id || rows[0]?.id || 0;
}

function many2oneId(value: unknown): number {
  return Array.isArray(value) ? Number(value[0]) || 0 : 0;
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
