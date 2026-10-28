import { run } from './db.js';
import { DEFAULT_COMPANY_ODOO_ID, getActiveCompany, listCompanies } from './forms-companies.js';
import {
  getFormDocument,
  listFormDocuments,
  type FormDocument,
} from './forms.js';
import { documentTitle, shouldAutofillFormTitle, type FormKind } from './forms-fields.js';
import { odooCreate, odooExecuteKw, odooSearchRead, odooWrite } from './odoo-client.js';
import { toOdooNumber } from './odoo-number.js';
import {
  cancelProductionInOdoo,
  isProductionLocked,
  productLineUomId,
  pushProductionToOdoo,
  type OdooStockProduct,
} from './odoo-production.js';
import {
  findCategoryId,
  ensureIncomingPickingTypeId,
  findPaymentTermId,
  findSaleTagIds,
  findSalesTeamId,
  findTaxIds,
  findUomId,
} from './odoo-resolve.js';

export { getOdooPullProgress, pullFromOdoo, pullOdooCatalog } from './odoo-pull.js';

const num = toOdooNumber;

function docCompanyId(doc: FormDocument): number {
  const raw = doc.company_odoo_id || doc.header.company_odoo_id || DEFAULT_COMPANY_ODOO_ID;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Number(DEFAULT_COMPANY_ODOO_ID);
}

/**
 * Como no Odoo: pedido confirmado continua editável (quantidade, itens); só bloqueado/cancelado trava.
 */
export function isFormOrderEditable(doc: FormDocument): boolean {
  // Ordem de produção concluída/cancelada: o estoque já mudou, só “Desmontar” no Odoo desfaz.
  if (doc.kind === 'production') return !isProductionLocked(doc);
  if (doc.kind !== 'sale' && doc.kind !== 'purchase') return true;
  const state = String(doc.header.odoo_state || doc.status || 'draft').toLowerCase();
  return state !== 'done' && state !== 'cancel';
}

export function assertFormOrderEditable(doc: FormDocument, action: 'editar' | 'excluir' = 'editar'): void {
  if (isFormOrderEditable(doc)) return;
  if (doc.kind === 'production') {
    const ref = doc.header.order_reference || `#${doc.header.odoo_id}`;
    throw new Error(
      doc.header.odoo_state === 'cancel'
        ? `Ordem de produção ${ref} cancelada no Odoo; não é possível ${action} no Vertice.`
        : `Ordem de produção ${ref} concluída no Odoo; não é possível ${action} no Vertice. Para desfazer, use “Desmontar” na ordem no Odoo.`,
    );
  }
  const state = String(doc.header.odoo_state || doc.status || '');
  throw new Error(
    state === 'cancel'
      ? `Pedido cancelado no Odoo; não é possível ${action} no Vertice.`
      : `Pedido bloqueado no Odoo; não é possível ${action} no Vertice. Desbloqueie no Odoo para alterar.`,
  );
}

export async function markDocSyncPending(id: string): Promise<FormDocument> {
  const doc = await getFormDocument(id);
  if (!doc) throw new Error('Formulário não encontrado');
  const header = {
    ...doc.header,
    odoo_sync_pending: '1',
    odoo_sync_error: '',
  };
  await run(`UPDATE forms_documents SET header_json = $2, updated_at = NOW() WHERE id = $1`, [
    id,
    JSON.stringify(header),
  ]);
  const updated = await getFormDocument(id);
  if (!updated) throw new Error('Formulário não encontrado');
  return updated;
}

/** Push em background após gravar no Vertice — confirma no Odoo (dado real, sem rascunho). */
export function scheduleOdooPush(id: string): void {
  setImmediate(() => {
    pushFormToOdoo(id, { confirm: true }).catch((error) => {
      console.error(`[odoo-auto-push] ${id}:`, error instanceof Error ? error.message : error);
    });
  });
}

export function schedulePartnerPush(id: string): void {
  setImmediate(() => {
    import('./forms-partner-sync.js')
      .then(({ pushPartnerToOdoo }) => pushPartnerToOdoo(id))
      .catch((error) => {
        console.error(`[odoo-auto-push-partner] ${id}:`, error instanceof Error ? error.message : error);
      });
  });
}

async function cancelOdooOrder(model: 'sale.order' | 'purchase.order', odooId: number): Promise<void> {
  const rows = await odooSearchRead<{ state: string }>(model, [['id', '=', odooId]], ['state'], {
    limit: 1,
  });
  const state = String(rows[0]?.state || '').toLowerCase();
  if (!rows.length || state === 'cancel') return;
  try {
    await odooExecuteKw(model, 'button_cancel', [[odooId]]);
  } catch {
    await odooWrite(model, [odooId], { state: 'cancel' });
  }
}

/** Cancela pedido ou arquiva produto no Odoo. Não remove o registro local. */
export async function cancelFormInOdoo(doc: FormDocument): Promise<void> {
  const odooId = num(doc.header.odoo_id, 0);
  if (odooId <= 0) return;
  if (doc.kind === 'sale') {
    await cancelOdooOrder('sale.order', odooId);
    return;
  }
  if (doc.kind === 'purchase') {
    await cancelOdooOrder('purchase.order', odooId);
    return;
  }
  if (doc.kind === 'production') {
    await cancelProductionInOdoo(doc);
    return;
  }
  if (doc.kind === 'product') {
    await odooWrite('product.template', [odooId], { active: false });
  }
}

export async function archivePartnerInOdoo(odooIdRaw: string): Promise<void> {
  const odooId = num(odooIdRaw, 0);
  if (odooId <= 0) return;
  await odooWrite('res.partner', [odooId], { active: false });
}

async function fetchOrderNameAndState(
  model: 'sale.order' | 'purchase.order',
  odooId: number,
): Promise<{ name: string; state: string }> {
  const rows = await odooSearchRead<{ name: string; state: string }>(
    model,
    [['id', '=', odooId]],
    ['name', 'state'],
    { limit: 1 },
  );
  return {
    name: String(rows[0]?.name || ''),
    state: String(rows[0]?.state || 'draft'),
  };
}

async function setDocOdooMeta(
  id: string,
  odooId: number,
  options: { error?: string; orderModel?: 'sale.order' | 'purchase.order' } = {},
): Promise<FormDocument> {
  const doc = await getFormDocument(id);
  if (!doc) throw new Error('Formulário não encontrado');
  const error = options.error || '';
  const header: Record<string, string> = {
    ...doc.header,
    odoo_id: String(odooId),
    odoo_synced_at: new Date().toISOString(),
    odoo_sync_error: error,
    odoo_sync_pending: error ? '1' : '',
  };
  let status = doc.status;
  let title = doc.title;

  if (!error && options.orderModel && odooId > 0) {
    const order = await fetchOrderNameAndState(options.orderModel, odooId);
    if (order.name) {
      header.order_reference = order.name;
      if (shouldAutofillFormTitle(doc.kind, title, header)) {
        title = documentTitle(doc.kind, header);
      }
    }
    if (order.state) {
      header.odoo_state = order.state;
      status = order.state;
    }
  }

  await run(
    `UPDATE forms_documents
     SET title = $2, status = $3, header_json = $4, updated_at = NOW()
     WHERE id = $1`,
    [id, title, status, JSON.stringify(header)],
  );
  const updated = await getFormDocument(id);
  if (!updated) throw new Error('Formulário não encontrado');
  return updated;
}

async function findPartnerId(name: string, as: 'customer' | 'vendor'): Promise<number> {
  const clean = name.trim();
  if (!clean) throw new Error(as === 'customer' ? 'Cliente obrigatório' : 'Fornecedor obrigatório');
  const found = await odooSearchRead<{ id: number }>(
    'res.partner',
    [['name', 'ilike', clean]],
    ['id'],
    { limit: 1 },
  );
  if (found[0]?.id) return found[0].id;
  const values: Record<string, unknown> = { name: clean };
  if (as === 'customer') values.customer_rank = 1;
  if (as === 'vendor') values.supplier_rank = 1;
  return odooCreate('res.partner', values);
}

async function findProductVariantId(
  productName: string,
  unitPrice?: string,
  as: 'sale' | 'purchase' = 'sale',
  companyId = Number(DEFAULT_COMPANY_ODOO_ID),
): Promise<number> {
  const clean = productName.trim();
  if (!clean) throw new Error('Produto obrigatório na linha');
  const templates = await odooSearchRead<{ id: number; product_variant_id: [number, string] | number }>(
    'product.template',
    [
      '&',
      ['name', 'ilike', clean],
      '|',
      ['company_id', '=', companyId],
      ['company_id', '=', false],
    ],
    ['id', 'product_variant_id'],
    { limit: 1 },
  );
  if (templates[0]) {
    const variant = templates[0].product_variant_id;
    if (Array.isArray(variant)) return variant[0];
    if (typeof variant === 'number') return variant;
  }
  const tmplId = await odooCreate('product.template', {
    name: clean,
    list_price: as === 'sale' ? num(unitPrice) : 0,
    standard_price: as === 'purchase' ? num(unitPrice) : 0,
    type: 'consu',
    is_storable: true,
    company_id: companyId,
  });
  const created = await odooSearchRead<{ product_variant_id: [number, string] | number }>(
    'product.template',
    [['id', '=', tmplId]],
    ['product_variant_id'],
    { limit: 1 },
  );
  const variant = created[0]?.product_variant_id;
  if (Array.isArray(variant)) return variant[0];
  if (typeof variant === 'number') return variant;
  throw new Error(`Não foi possível obter variante do produto ${clean}`);
}

export async function pushProductToOdoo(doc: FormDocument): Promise<FormDocument> {
  const name = doc.header.name?.trim();
  if (!name) throw new Error('Nome do produto obrigatório');
  const companyId = docCompanyId(doc);
  const values: Record<string, unknown> = {
    name,
    list_price: num(doc.header.sales_price),
    standard_price: num(doc.header.cost),
    default_code: doc.header.internal_ref || false,
    type: 'consu',
    is_storable: String(doc.header.track_inventory || 'True').toLowerCase() !== 'false',
    company_id: companyId,
  };

  // Documento antigo sem o campo não zera o peso já cadastrado no Odoo.
  if (String(doc.header.weight || '').trim()) values.weight = num(doc.header.weight);

  const categId = await findCategoryId(doc.header.category || '');
  if (categId > 0) values.categ_id = categId;

  const uomId = await findUomId(doc.header.uom || '');
  if (uomId > 0) {
    // Só uom_id: no Odoo 19 uom_po_id não existe mais em product.template.
    values.uom_id = uomId;
  }

  const existingId = num(doc.header.odoo_id, 0);
  let odooId = existingId;
  if (existingId > 0) {
    await odooWrite('product.template', [existingId], values);
  } else {
    const found = await odooSearchRead<{ id: number }>(
      'product.template',
      [
        '&',
        ['name', '=', name],
        '|',
        ['company_id', '=', companyId],
        ['company_id', '=', false],
      ],
      ['id'],
      { limit: 1 },
    );
    if (found[0]?.id) {
      odooId = found[0].id;
      await odooWrite('product.template', [odooId], values);
    } else {
      odooId = await odooCreate('product.template', values);
    }
  }
  return setDocOdooMeta(doc.id, odooId, {});
}

async function taxLookupOptions(
  companyId: number,
  typeTaxUse: 'sale' | 'purchase',
): Promise<{ companyId: number; countryId?: number; typeTaxUse: 'sale' | 'purchase' }> {
  const companies = await listCompanies().catch(() => []);
  const company =
    companies.find((item) => item.id === String(companyId)) || (await getActiveCompany());
  const countryId = num(company?.country_odoo_id, 0);
  return {
    companyId,
    countryId: countryId > 0 ? countryId : undefined,
    typeTaxUse,
  };
}

/**
 * Unidade da linha (ex.: “Bag”) → uom_id do Odoo permitido para o produto; o Odoo converte
 * para a unidade de estoque (2 Bag = 200 KG). Vazio = unidade do produto (campo omitido).
 */
async function lineUomIdForOdoo(variantId: number, productName: string, uomName: string): Promise<number> {
  if (!String(uomName || '').trim()) return 0;
  const [variant] = await odooSearchRead<{ uom_id: unknown }>('product.product', [['id', '=', variantId]], ['uom_id'], {
    limit: 1,
  });
  const uom = variant?.uom_id;
  const product: OdooStockProduct = {
    variantId,
    templateId: 0,
    uomId: Array.isArray(uom) ? Number(uom[0]) || 0 : 0,
    uomName: Array.isArray(uom) ? String(uom[1] || '') : '',
    name: productName,
  };
  return productLineUomId(product, uomName);
}

async function buildSaleLines(
  doc: FormDocument,
  companyId: number,
): Promise<unknown[]> {
  const taxOpts = await taxLookupOptions(companyId, 'sale');
  const lines: unknown[] = [];
  for (const line of doc.lines) {
    const productName = line.values.product || '';
    if (!productName.trim()) continue;
    const productId = await findProductVariantId(productName, line.values.unit_price, 'sale', companyId);
    const lineVals: Record<string, unknown> = {
      product_id: productId,
      product_uom_qty: num(line.values.quantity, 1),
      price_unit: num(line.values.unit_price),
      name: productName,
    };
    const uomId = await lineUomIdForOdoo(productId, productName, line.values.uom || '');
    if (uomId > 0) lineVals.product_uom_id = uomId;
    const taxIds = await findTaxIds(line.values.taxes || '', taxOpts);
    if (taxIds.length) lineVals.tax_ids = [[6, 0, taxIds]];
    lines.push([0, 0, lineVals]);
  }
  if (!lines.length) throw new Error('Informe ao menos uma linha de produto');
  return lines;
}

export type PushOptions = {
  /** Gravação feita no Vertice: confirma no Odoo e valida recebimento/entrega (sem rascunho). */
  confirm?: boolean;
};

type OrderModel = 'sale.order' | 'purchase.order';

const orderContext = (companyId: number) => ({ allowed_company_ids: [companyId], force_company: companyId });

async function readOrderState(model: OrderModel, id: number): Promise<{ state: string; name: string; locked: boolean }> {
  const rows =
    (await odooSearchRead<{ state: string; name: string; locked?: boolean }>(model, [['id', '=', id]], ['state', 'name', 'locked'], {
      limit: 1,
    }).catch(() => null)) ||
    (await odooSearchRead<{ state: string; name: string }>(model, [['id', '=', id]], ['state', 'name'], { limit: 1 }));
  const row = rows[0] as { state?: string; name?: string; locked?: boolean } | undefined;
  if (!row) throw new Error(`Pedido Odoo ${id} não encontrado`);
  return { state: String(row.state || ''), name: String(row.name || ''), locked: Boolean(row.locked) };
}

/** Rascunho no Odoo: as linhas podem ser reescritas por inteiro (como antes). */
function isDraftOrderState(state: string): boolean {
  return state === 'draft' || state === 'sent' || state === 'to approve';
}

/**
 * Pedido já confirmado: o Odoo não deixa apagar linhas — atualiza as do mesmo produto (na ordem),
 * cria as novas e zera as que saíram. O Odoo ajusta recebimento/entrega pendentes.
 */
async function confirmedOrderLineCommands(
  model: OrderModel,
  orderId: number,
  desired: unknown[],
  qtyField: 'product_qty' | 'product_uom_qty',
): Promise<unknown[]> {
  const lineModel = `${model}.line`;
  const existing = await odooSearchRead<{ id: number; product_id: unknown }>(
    lineModel,
    [['order_id', '=', orderId], ['display_type', '=', false]],
    ['id', 'product_id'],
    { order: 'sequence asc, id asc' },
  );
  const used = new Set<number>();
  const commands: unknown[] = [];
  for (const command of desired) {
    const vals = (Array.isArray(command) ? command[2] : {}) as Record<string, unknown>;
    const match = existing.find(
      (line) => !used.has(line.id) && Array.isArray(line.product_id) && line.product_id[0] === vals.product_id,
    );
    if (match) {
      used.add(match.id);
      commands.push([1, match.id, vals]);
    } else {
      commands.push([0, 0, vals]);
    }
  }
  for (const line of existing) {
    if (!used.has(line.id)) commands.push([1, line.id, { [qtyField]: 0 }]);
  }
  return commands;
}

/** Valida as transferências abertas do pedido (recebimento/entrega) com as quantidades pedidas. */
async function validateOrderPickings(model: OrderModel, orderId: number, companyId: number): Promise<void> {
  const context = orderContext(companyId);
  const [order] = await odooSearchRead<{ picking_ids: number[] }>(model, [['id', '=', orderId]], ['picking_ids'], {
    limit: 1,
  });
  const pickings = await odooSearchRead<{ id: number; name: string; state: string }>(
    'stock.picking',
    [['id', 'in', order?.picking_ids || []], ['state', 'not in', ['done', 'cancel']]],
    ['id', 'name', 'state'],
  );
  const label = model === 'purchase.order' ? 'Recebimento' : 'Entrega';
  for (const picking of pickings) {
    if (picking.state === 'draft') {
      await odooExecuteKw('stock.picking', 'action_confirm', [[picking.id]], { context });
    }
    const moves = await odooSearchRead<{ id: number; product_uom_qty: number }>(
      'stock.move',
      [['picking_id', '=', picking.id], ['state', 'not in', ['done', 'cancel']]],
      ['id', 'product_uom_qty'],
    );
    if (!moves.some((move) => Number(move.product_uom_qty) > 0)) continue;
    for (const move of moves) {
      await odooWrite('stock.move', [move.id], { quantity: Number(move.product_uom_qty), picked: true });
    }
    await odooExecuteKw('stock.picking', 'button_validate', [[picking.id]], {
      context: { ...context, skip_backorder: true, picking_ids_not_to_backorder: [picking.id], skip_sms: true },
    });
    const [after] = await odooSearchRead<{ state: string }>('stock.picking', [['id', '=', picking.id]], ['state'], {
      limit: 1,
    });
    if (after?.state !== 'done') {
      throw new Error(`${label} ${picking.name} não foi validado no Odoo (estado ${after?.state || '?'})`);
    }
  }
}

/** Bloqueado/cancelado no Odoo: o Odoo não aceita alteração — avisa em vez de tentar. */
function assertOrderWritable(order: { state: string; name: string; locked: boolean }): void {
  if (order.state === 'cancel') throw new Error(`Pedido ${order.name} está cancelado no Odoo — não é possível alterar`);
  if (order.state === 'done' || order.locked) {
    throw new Error(`Pedido ${order.name} está bloqueado no Odoo — desbloqueie no Odoo para alterar`);
  }
}

export async function pushSaleToOdoo(doc: FormDocument, options: PushOptions = {}): Promise<FormDocument> {
  const companyId = docCompanyId(doc);
  const partnerId = await findPartnerId(doc.header.customer || '', 'customer');
  const lines = await buildSaleLines(doc, companyId);

  const values: Record<string, unknown> = {
    partner_id: partnerId,
    client_order_ref: doc.header.customer_reference || false,
    company_id: companyId,
  };
  if (doc.header.order_date) values.date_order = doc.header.order_date;
  if (doc.header.expiration) values.validity_date = doc.header.expiration;

  const paymentTermId = await findPaymentTermId(doc.header.payment_terms || '');
  values.payment_term_id = paymentTermId > 0 ? paymentTermId : false;

  const teamId = await findSalesTeamId(doc.header.sales_team || '');
  if (teamId > 0) values.team_id = teamId;

  const tagIds = await findSaleTagIds(doc.header.tags || '');
  values.tag_ids = [[6, 0, tagIds]];

  const existingId = num(doc.header.odoo_id, 0);
  let odooId = existingId;
  if (existingId > 0) {
    const order = await readOrderState('sale.order', existingId);
    assertOrderWritable(order);
    if (isDraftOrderState(order.state)) {
      await odooWrite('sale.order', [existingId], { ...values, order_line: [[5, 0, 0], ...lines] });
    } else {
      // Confirmado: cliente/data do pedido ficam como estão (o Odoo os trava após confirmar).
      const { partner_id: _partner, date_order: _date, company_id: _company, ...editable } = values;
      const orderLine = await confirmedOrderLineCommands('sale.order', existingId, lines, 'product_uom_qty');
      await odooWrite('sale.order', [existingId], { ...editable, order_line: orderLine });
    }
  } else {
    values.order_line = lines;
    odooId = await odooCreate('sale.order', values);
  }

  if (options.confirm) {
    const order = await readOrderState('sale.order', odooId);
    if (isDraftOrderState(order.state)) {
      await odooExecuteKw('sale.order', 'action_confirm', [[odooId]], { context: orderContext(companyId) });
    }
    await validateOrderPickings('sale.order', odooId, companyId);
  }
  return setDocOdooMeta(doc.id, odooId, { orderModel: 'sale.order' });
}

async function buildPurchaseLines(
  doc: FormDocument,
  companyId: number,
): Promise<unknown[]> {
  const taxOpts = await taxLookupOptions(companyId, 'purchase');
  const lines: unknown[] = [];
  for (const line of doc.lines) {
    const productName = line.values.product || '';
    if (!productName.trim()) continue;
    const productId = await findProductVariantId(
      productName,
      line.values.unit_price,
      'purchase',
      companyId,
    );
    const lineVals: Record<string, unknown> = {
      product_id: productId,
      product_qty: num(line.values.quantity, 1),
      price_unit: num(line.values.unit_price),
      name: productName,
    };
    const uomId = await lineUomIdForOdoo(productId, productName, line.values.uom || '');
    if (uomId > 0) lineVals.uom_id = uomId;
    const taxIds = await findTaxIds(line.values.taxes || '', taxOpts);
    if (taxIds.length) lineVals.taxes_id = [[6, 0, taxIds]];
    lines.push([0, 0, lineVals]);
  }
  if (!lines.length) throw new Error('Informe ao menos uma linha de produto');
  return lines;
}

function purchaseLinesWithTaxIds(lineValsList: unknown[]): unknown[] {
  return lineValsList.map((cmd) => {
    if (!Array.isArray(cmd) || (cmd[0] !== 0 && cmd[0] !== 1)) return cmd;
    const vals = { ...(cmd[2] as Record<string, unknown>) };
    if (vals.taxes_id && !vals.tax_ids) {
      vals.tax_ids = vals.taxes_id;
      delete vals.taxes_id;
    }
    return [cmd[0], cmd[1], vals];
  });
}

export async function pushPurchaseToOdoo(doc: FormDocument, options: PushOptions = {}): Promise<FormDocument> {
  const companyId = docCompanyId(doc);
  const partnerId = await findPartnerId(doc.header.vendor || '', 'vendor');
  const lines = await buildPurchaseLines(doc, companyId);
  const pickingTypeId = await ensureIncomingPickingTypeId(companyId);
  if (pickingTypeId <= 0) {
    throw new Error(
      `Empresa Odoo ${companyId} sem depósito/tipo de recebimento (picking_type_id). Não foi possível criar um warehouse automático — configure um depósito no Odoo.`,
    );
  }

  const values: Record<string, unknown> = {
    partner_id: partnerId,
    partner_ref: doc.header.vendor_reference || false,
    company_id: companyId,
    picking_type_id: pickingTypeId,
  };
  if (doc.header.order_deadline) values.date_order = doc.header.order_deadline;
  if (doc.header.expected_arrival) values.date_planned = doc.header.expected_arrival;

  const paymentTermId = await findPaymentTermId(doc.header.payment_terms || '');
  values.payment_term_id = paymentTermId > 0 ? paymentTermId : false;

  const existingId = num(doc.header.odoo_id, 0);
  let odooId = existingId;
  let confirmed = false;
  if (existingId > 0) {
    const order = await readOrderState('purchase.order', existingId);
    assertOrderWritable(order);
    confirmed = !isDraftOrderState(order.state);
  }
  // Confirmado: fornecedor/data/depósito ficam como estão (o Odoo os trava após confirmar).
  const { partner_id: _partner, date_order: _date, company_id: _company, picking_type_id: _type, ...editable } = values;
  const orderLine = confirmed
    ? await confirmedOrderLineCommands('purchase.order', existingId, lines, 'product_qty')
    : [[5, 0, 0], ...lines];
  const send = async (commands: unknown[]) => {
    if (existingId > 0) {
      await odooWrite('purchase.order', [existingId], { ...(confirmed ? editable : values), order_line: commands });
    } else {
      odooId = await odooCreate('purchase.order', { ...values, order_line: commands.slice(1) });
    }
  };
  try {
    await send(orderLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/taxes_id|invalid field/i.test(message)) throw error;
    await send(purchaseLinesWithTaxIds(orderLine));
  }

  if (options.confirm) {
    const order = await readOrderState('purchase.order', odooId);
    if (order.state === 'draft' || order.state === 'sent') {
      await odooExecuteKw('purchase.order', 'button_confirm', [[odooId]], { context: orderContext(companyId) });
    }
    const after = await readOrderState('purchase.order', odooId);
    if (after.state === 'to approve') {
      throw new Error(`Pedido ${after.name} aguardando aprovação no Odoo — aprove para receber`);
    }
    await validateOrderPickings('purchase.order', odooId, companyId);
  }
  return setDocOdooMeta(doc.id, odooId, { orderModel: 'purchase.order' });
}

/** Salvar no Vertice grava dado real no Odoo: confirma e recebe/entrega (Fabricação já vai concluída). */
export async function pushFormToOdoo(id: string, options: PushOptions = {}): Promise<FormDocument> {
  const doc = await getFormDocument(id);
  if (!doc) throw new Error('Formulário não encontrado');
  try {
    if (doc.kind === 'product') return await pushProductToOdoo(doc);
    if (doc.kind === 'sale') return await pushSaleToOdoo(doc, options);
    if (doc.kind === 'purchase') return await pushPurchaseToOdoo(doc, options);
    if (doc.kind === 'production') return await pushProductionToOdoo(doc);
    throw new Error('Tipo não suportado');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha no envio';
    const header = {
      ...doc.header,
      odoo_sync_error: message,
      odoo_sync_pending: '',
    };
    await run(`UPDATE forms_documents SET header_json = $2, updated_at = NOW() WHERE id = $1`, [
      id,
      JSON.stringify(header),
    ]);
    throw error;
  }
}

export async function pushFormsByKind(kind: FormKind): Promise<{
  ok: number;
  failed: number;
  errors: string[];
}> {
  const docs = await listFormDocuments(kind);
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const doc of docs) {
    try {
      await pushFormToOdoo(doc.id);
      ok += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${doc.title || doc.id}: ${error instanceof Error ? error.message : 'erro'}`);
    }
  }
  return { ok, failed, errors };
}

/** Envia inventário, compras e vendas da empresa ativa ao Odoo. */
export async function pushAllFormsToOdoo(): Promise<{
  ok: number;
  failed: number;
  errors: string[];
  byKind: Record<'product' | 'purchase' | 'sale', { ok: number; failed: number }>;
}> {
  const kinds = ['product', 'purchase', 'sale'] as const;
  const byKind = {
    product: { ok: 0, failed: 0 },
    purchase: { ok: 0, failed: 0 },
    sale: { ok: 0, failed: 0 },
  };
  const errors: string[] = [];
  let ok = 0;
  let failed = 0;

  for (const kind of kinds) {
    const result = await pushFormsByKind(kind);
    byKind[kind] = { ok: result.ok, failed: result.failed };
    ok += result.ok;
    failed += result.failed;
    for (const message of result.errors) {
      errors.push(`[${kind}] ${message}`);
    }
  }

  return { ok, failed, errors, byKind };
}
