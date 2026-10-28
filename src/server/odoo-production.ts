import { run } from './db.js';
import { DEFAULT_COMPANY_ODOO_ID } from './forms-companies.js';
import { documentTitle, productionBalance, shouldAutofillFormTitle } from './forms-fields.js';
import { convertUom, findUom, listUomInfos, toKg, type UomInfo } from './forms-uom.js';
import { getFormDocument, type FormDocument } from './forms.js';
import { odooCreate, odooExecuteKw, odooSearchRead, odooWrite } from './odoo-client.js';
import { fromOdooNumber, toOdooNumber } from './odoo-number.js';
import { findUomId } from './odoo-resolve.js';

// Fabricação = espelho de 1 mrp.production: componente (produto de entrada) → produto principal
// (1ª linha) + subprodutos (demais), cada um na sua unidade do Odoo. O status do Vertice é o
// state da ordem; “Concluído” lança no estoque e não é desfeito pelo Vertice (só “Desmontar”).

export type OdooStockProduct = {
  variantId: number;
  templateId: number;
  uomId: number;
  uomName: string;
  name: string;
};

type MoRow = {
  id: number;
  name: string;
  state: string;
  product_qty: number;
  location_src_id: unknown;
  location_dest_id: unknown;
  production_location_id: unknown;
};

const m2oId = (value: unknown): number =>
  Array.isArray(value) ? Number(value[0]) || 0 : typeof value === 'number' ? value : 0;
const m2oName = (value: unknown): string => (Array.isArray(value) ? String(value[1] || '') : '');

function companyOf(doc: FormDocument): number {
  const n = Number(doc.company_odoo_id || doc.header.company_odoo_id || DEFAULT_COMPANY_ODOO_ID);
  return Number.isFinite(n) && n > 0 ? n : Number(DEFAULT_COMPANY_ODOO_ID);
}

const companyContext = (companyId: number) => ({ allowed_company_ids: [companyId], force_company: companyId });

/** Ordem concluída ou cancelada: o Vertice não altera mais (o estoque já mudou ou foi descartada). */
export function isProductionLocked(doc: Pick<FormDocument, 'header'>): boolean {
  const state = String(doc.header.odoo_state || '').toLowerCase();
  return state === 'done' || state === 'cancel';
}

/** Nome exato (sem diferenciar maiúsculas): “Bag” não pode virar “Bag PET”. */
export async function findOdooProductExact(
  name: string,
  companyId: number,
  options: { create?: boolean } = {},
): Promise<OdooStockProduct | null> {
  const clean = name.trim();
  if (!clean) return null;
  const read = () =>
    odooSearchRead<{ id: number; name: string; product_variant_id: unknown; uom_id: unknown }>(
      'product.template',
      ['&', ['name', '=ilike', clean], '|', ['company_id', '=', companyId], ['company_id', '=', false]],
      ['id', 'name', 'product_variant_id', 'uom_id'],
      { limit: 1 },
    );
  let [row] = await read();
  if (!row && options.create) {
    const kg = await findUomId('KG');
    await odooCreate(
      'product.template',
      { name: clean, type: 'consu', is_storable: true, company_id: companyId, ...(kg > 0 ? { uom_id: kg } : {}) },
      { context: companyContext(companyId) },
    );
    [row] = await read();
  }
  if (!row) return null;
  return {
    variantId: m2oId(row.product_variant_id),
    templateId: row.id,
    uomId: m2oId(row.uom_id),
    uomName: m2oName(row.uom_id),
    name: String(row.name || clean),
  };
}

/**
 * Unidade da linha → id permitido no Odoo para o produto (a do produto ou uma das “Embalagens”).
 * Vazio = unidade do produto. Fora das permitidas → erro claro (o Odoo recusaria a linha).
 */
export async function productLineUomId(product: OdooStockProduct, uomName: string): Promise<number> {
  const wanted = String(uomName || '').trim();
  if (!wanted) return product.uomId;
  const [variant] = await odooSearchRead<{ uom_ids?: number[] }>(
    'product.product',
    [['id', '=', product.variantId]],
    ['uom_ids'],
    { limit: 1 },
  ).catch(() => [] as Array<{ uom_ids?: number[] }>);
  const ids = [product.uomId, ...(variant?.uom_ids || [])];
  const allowed = await odooSearchRead<{ id: number; name: string }>('uom.uom', [['id', 'in', ids]], ['id', 'name']);
  const hit = findUom(
    allowed.map((item) => ({ name: item.name, rootId: String(item.id), factor: 1 })),
    wanted,
  );
  const id = hit ? allowed.find((item) => item.name === hit.name)?.id : undefined;
  if (!id) {
    throw new Error(
      `Unidade “${wanted}” não está liberada para “${product.name}” no Odoo — cadastre-a nas Embalagens do produto.`,
    );
  }
  return id;
}

export async function productQtyAvailable(variantId: number, companyId: number): Promise<number> {
  const rows = await odooExecuteKw<Array<{ qty_available: number }>>(
    'product.product',
    'read',
    [[variantId], ['qty_available']],
    { context: companyContext(companyId) },
  );
  return Number(rows?.[0]?.qty_available) || 0;
}

async function productionPickingTypeId(companyId: number): Promise<number> {
  const [row] = await odooSearchRead<{ id: number }>(
    'stock.picking.type',
    [['code', '=', 'mrp_operation'], ['company_id', '=', companyId]],
    ['id'],
    { limit: 1 },
  );
  if (!row?.id) {
    throw new Error(`Empresa Odoo ${companyId} sem operação de Fabricação — verifique o módulo Fabricação e o depósito.`);
  }
  return row.id;
}

async function readMo(id: number): Promise<MoRow | undefined> {
  const [row] = await odooSearchRead<MoRow>(
    'mrp.production',
    [['id', '=', id]],
    ['id', 'name', 'state', 'product_qty', 'location_src_id', 'location_dest_id', 'production_location_id'],
    { limit: 1 },
  );
  return row;
}

/** Conversor do balanço: unidade vazia = unidade do produto (lida do Odoo). */
function kgConverter(uoms: UomInfo[], productUoms: Map<string, string>) {
  return (qty: number, uom: string, product: string) =>
    toKg(qty, uom || productUoms.get(product.trim().toLowerCase()) || '', uoms);
}

type PlannedLine = { product: OdooStockProduct; qty: number; uomId: number; costShare: number };

/** Rascunho: componente e subprodutos refeitos a partir do documento (como o Odoo faz ao editar). */
async function writeMoves(mo: MoRow, companyId: number, input: PlannedLine, byproducts: PlannedLine[]): Promise<void> {
  const context = companyContext(companyId);
  const [moProduct] = await odooSearchRead<{ product_id: unknown }>('mrp.production', [['id', '=', mo.id]], ['product_id'], {
    limit: 1,
  });
  const mainProductId = m2oId(moProduct?.product_id);
  const existing = await odooSearchRead<{ id: number; product_id: unknown; raw_material_production_id: unknown }>(
    'stock.move',
    ['|', ['raw_material_production_id', '=', mo.id], ['production_id', '=', mo.id]],
    ['id', 'product_id', 'raw_material_production_id'],
  );
  // Mantém só a saída do produto principal (o Odoo a recalcula pela quantidade da ordem).
  const stale = existing
    .filter((move) => m2oId(move.raw_material_production_id) === mo.id || m2oId(move.product_id) !== mainProductId)
    .map((move) => move.id);
  if (stale.length) await odooExecuteKw('stock.move', 'unlink', [stale], { context });

  await odooCreate(
    'stock.move',
    {
      raw_material_production_id: mo.id,
      product_id: input.product.variantId,
      product_uom_qty: input.qty,
      uom_id: input.uomId,
      location_id: m2oId(mo.location_src_id),
      location_dest_id: m2oId(mo.production_location_id),
      company_id: companyId,
    },
    { context },
  );
  for (const line of byproducts) {
    await odooCreate(
      'stock.move',
      {
        production_id: mo.id,
        product_id: line.product.variantId,
        product_uom_qty: line.qty,
        uom_id: line.uomId,
        location_id: m2oId(mo.production_location_id),
        location_dest_id: m2oId(mo.location_dest_id),
        company_id: companyId,
        cost_share: line.costShare,
      },
      { context },
    );
  }
}

/**
 * Confirma e conclui como o botão “Produzir” do Odoo: com qty_producing zerado, o próprio
 * button_mark_done preenche componente, produto e subprodutos com as quantidades planejadas.
 * (Gravar qty_producing antes faz o Odoo pular esse cálculo e cancelar a saída com 0.)
 */
async function finishMo(mo: MoRow, companyId: number): Promise<void> {
  const context = companyContext(companyId);
  if (mo.state === 'draft') await odooExecuteKw('mrp.production', 'action_confirm', [[mo.id]], { context });
  const result = await odooExecuteKw<unknown>('mrp.production', 'button_mark_done', [[mo.id]], {
    context: { ...context, skip_consumption: true, skip_backorder: true, mo_ids_to_backorder: [] },
  });
  const after = await readMo(mo.id);
  if (after?.state !== 'done') {
    const wizard =
      result && typeof result === 'object' && 'res_model' in result
        ? ` (Odoo pediu ${String((result as { res_model: unknown }).res_model)})`
        : '';
    throw new Error(`Ordem ${mo.name} não foi concluída no Odoo: estado ${after?.state || '?'}${wizard}`);
  }
}

async function writeHeader(id: string, header: Record<string, string>, extra: { title?: string; status?: string } = {}) {
  const sets = ['header_json = $2', 'updated_at = NOW()'];
  const params: unknown[] = [id, JSON.stringify(header)];
  if (extra.title) {
    params.push(extra.title);
    sets.push(`title = $${params.length}`);
  }
  if (extra.status) {
    params.push(extra.status);
    sets.push(`status = $${params.length}`);
  }
  await run(`UPDATE forms_documents SET ${sets.join(', ')} WHERE id = $1`, params);
}

/** Envia o documento como mrp.production e aplica a transição pedida no status. */
export async function pushProductionToOdoo(doc: FormDocument): Promise<FormDocument> {
  try {
    return await registerProduction(doc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/permiss/i.test(message) && /mrp\.|Fabrica/i.test(message)) {
      throw new Error(
        'O usuário da integração no Odoo não tem acesso a Fabricação. No Odoo: Configurações → Usuários → (login da integração) → Fabricação: Administrador.',
      );
    }
    throw error;
  }
}

async function registerProduction(doc: FormDocument): Promise<FormDocument> {
  const companyId = companyOf(doc);
  const context = companyContext(companyId);
  const header: Record<string, string> = { ...doc.header, odoo_sync_pending: '', odoo_sync_error: '' };
  const target = String(doc.status || 'draft');
  let mo = toOdooNumber(doc.header.odoo_id, 0) > 0 ? await readMo(toOdooNumber(doc.header.odoo_id, 0)) : undefined;

  if (!mo || mo.state === 'draft') {
    const sourceName = String(doc.header.input_product || '').trim();
    const source = await findOdooProductExact(sourceName, companyId);
    if (!source) throw new Error(`Produto de entrada “${sourceName || '(vazio)'}” não existe no Odoo — cadastre no Inventário.`);
    const outputs: Array<{ product: OdooStockProduct; line: Record<string, string> }> = [];
    for (const line of doc.lines) {
      const name = String(line.values.product || '').trim();
      if (!name || toOdooNumber(line.values.quantity, 0) <= 0) continue;
      const product = await findOdooProductExact(name, companyId, { create: true });
      if (!product) throw new Error(`Não foi possível achar/criar o produto “${name}” no Odoo`);
      outputs.push({ product, line: line.values });
    }
    if (!outputs.length) throw new Error('Informe ao menos um produto gerado com a quantidade');
    const inputQty = toOdooNumber(doc.header.input_qty, 0);
    if (inputQty <= 0) throw new Error('Informe a quantidade de entrada');

    const uoms = await listUomInfos();
    const productUoms = new Map(
      [source, ...outputs.map((item) => item.product)].map((item) => [item.name.toLowerCase(), item.uomName]),
    );
    const balance = productionBalance(doc, kgConverter(uoms, productUoms));
    const shareOf = (name: string) =>
      balance.lines.find((row) => row.product.toLowerCase() === name.toLowerCase())?.costShare ?? 0;

    const planned: PlannedLine[] = [];
    for (const item of outputs) {
      planned.push({
        product: item.product,
        qty: toOdooNumber(item.line.quantity, 0),
        uomId: await productLineUomId(item.product, item.line.uom || ''),
        costShare: shareOf(item.product.name),
      });
    }
    const input: PlannedLine = {
      product: source,
      qty: inputQty,
      uomId: await productLineUomId(source, doc.header.input_uom || ''),
      costShare: 0,
    };
    const [main, ...byproducts] = planned;
    const moValues: Record<string, unknown> = {
      product_id: main.product.variantId,
      product_qty: main.qty,
      uom_id: main.uomId,
      company_id: companyId,
      origin: (doc.header.notes || 'Vertice').slice(0, 120),
    };
    if (doc.header.production_date) moValues.date_start = `${doc.header.production_date.slice(0, 10)} 12:00:00`;

    if (!mo) {
      moValues.picking_type_id = await productionPickingTypeId(companyId);
      const id = await odooCreate('mrp.production', moValues, { context });
      mo = await readMo(id);
      if (!mo) throw new Error('Ordem de produção criada, mas não encontrada no Odoo');
      // Grava o vínculo antes de continuar: uma nova tentativa atualiza esta ordem, não cria outra.
      header.odoo_id = String(id);
      header.order_reference = mo.name;
      header.odoo_state = mo.state;
      await writeHeader(doc.id, header);
    } else {
      await odooWrite('mrp.production', [mo.id], moValues);
      mo = (await readMo(mo.id)) || mo;
    }
    await writeMoves(mo, companyId, input, byproducts);

    if (target === 'done' && source.uomName) {
      const inSourceUom = (() => {
        const from = findUom(uoms, doc.header.input_uom || source.uomName);
        const to = findUom(uoms, source.uomName);
        return from && to ? convertUom(inputQty, from, to) : null;
      })();
      const stock = await productQtyAvailable(source.variantId, companyId);
      header.stock_warning =
        inSourceUom != null && stock < inSourceUom
          ? `Estoque de ${source.name} insuficiente: havia ${fromOdooNumber(stock) || '0'} ${source.uomName} e a ordem consumiu ${fromOdooNumber(inSourceUom)} ${source.uomName}.`
          : '';
    }
  }

  if (target === 'done' && mo.state !== 'done') await finishMo(mo, companyId);
  else if (target === 'cancel' && mo.state !== 'cancel' && mo.state !== 'done') {
    await odooExecuteKw('mrp.production', 'action_cancel', [[mo.id]], { context });
  } else if (['confirmed', 'progress', 'to_close'].includes(target) && mo.state === 'draft') {
    await odooExecuteKw('mrp.production', 'action_confirm', [[mo.id]], { context });
  }

  const after = (await readMo(mo.id)) || mo;
  header.odoo_id = String(after.id);
  header.order_reference = after.name;
  header.odoo_state = after.state;
  header.odoo_synced_at = new Date().toISOString();
  const title = shouldAutofillFormTitle('production', doc.title, doc.header)
    ? documentTitle('production', header)
    : doc.title;
  await writeHeader(doc.id, header, { title, status: after.state });
  return (await getFormDocument(doc.id)) || doc;
}

/** Excluir no Vertice: cancela a ordem no Odoo (concluídas ficam bloqueadas antes daqui). */
export async function cancelProductionInOdoo(doc: FormDocument): Promise<void> {
  const id = toOdooNumber(doc.header.odoo_id, 0);
  if (id <= 0) return;
  const mo = await readMo(id);
  if (!mo || mo.state === 'cancel' || mo.state === 'done') return;
  await odooExecuteKw('mrp.production', 'action_cancel', [[id]], { context: companyContext(companyOf(doc)) });
}
