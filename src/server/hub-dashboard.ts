import { many } from './db.js';
import { json, route, type Ctx } from './http.js';
import { requireAuth } from './auth.js';
import { DEFAULT_COMPANY_ODOO_ID, getActiveCompanyId } from './forms-companies.js';
import { listUomInfos, toKg, type UomInfo } from './forms-uom.js';
import { odooConfigured, odooSearchRead } from './odoo-client.js';
import { toOdooNumber } from './odoo-number.js';
import { odooLabelPt } from './odoo-pt.js';
import { isAdm } from './users.js';

type DocRow = {
  id: string;
  status: string;
  header_json: string;
  company_odoo_id: string;
  created_at: string;
};

type LineRow = {
  document_id: string;
  line_json: string;
};

type LoadedDoc = {
  header: Record<string, string>;
  status: string;
  lines: Record<string, string>[];
  created_at: string;
};

type SeriesPoint = { label: string; value: number };
type StackedDay = { day: number; label: string; total: number; byProduct: Record<string, number> };

export type DashboardSection = {
  total: number;
  /** Unidade dos valores (kg, Bag, R$). */
  unit: string;
  daily: SeriesPoint[];
  /** Barras empilhadas por produto (vazio = barra única). */
  dailyStacked?: StackedDay[];
  products: string[];
};

function parseJson(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value || {})) {
      out[key] = item == null ? '' : String(item);
    }
    return out;
  } catch {
    return {};
  }
}

function parseBrNumber(raw: string): number {
  const text = String(raw || '')
    .trim()
    .replace(/\s/g, '');
  if (!text) return 0;
  if (text.includes(',') && text.includes('.')) {
    const n = Number(text.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  if (text.includes(',')) {
    const n = Number(text.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

/** Aceita dd/mm/aaaa, aaaa-mm-dd ou ISO. */
function parseDocDate(raw: string): Date | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const br = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]);
    const year = Number(br[3]);
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function dayLabel(day: number): string {
  return String(day).padStart(2, '0');
}

function inPeriod(date: Date | null, year: number, month: number): date is Date {
  if (!date) return false;
  return date.getFullYear() === year && date.getMonth() + 1 === month;
}

function nameKey(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function stateOf(doc: LoadedDoc): string {
  return String(doc.header.odoo_state || doc.status || 'draft').toLowerCase();
}

function isCancelled(doc: LoadedDoc): boolean {
  const state = stateOf(doc);
  return state === 'cancel' || state === 'cancelled' || state === 'canceled';
}

/** Venda confirmada: o Vertice valida a entrega no Odoo junto com a confirmação. */
function isConfirmedSale(doc: LoadedDoc): boolean {
  const state = stateOf(doc);
  return state === 'sale' || state === 'done';
}

/** Fabricação lançada (não rascunho nem cancelada). */
function isPostedProduction(doc: LoadedDoc): boolean {
  const state = stateOf(doc);
  return state !== 'draft' && !isCancelled(doc);
}

const isFardo = (product: string) => /fardo/.test(nameKey(product));
const isBagUnit = (uom: string) => /^bags?$/.test(nameKey(uom));
const isBagProduct = (product: string) => /\bbags?\b/.test(nameKey(product));
const isKgUnit = (uom: string) => /^(kg|kgs|quilos?|kilos?)$/.test(nameKey(uom));

async function loadKind(kind: 'purchase' | 'sale' | 'production', companyOdooId?: string): Promise<LoadedDoc[]> {
  const params: unknown[] = [kind];
  let sql = `SELECT id, status, header_json, company_odoo_id, created_at
    FROM forms_documents WHERE kind = $1`;
  if (companyOdooId) {
    params.push(companyOdooId);
    sql += ` AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`;
  }
  const docs = await many<DocRow>(sql, params);
  if (!docs.length) return [];

  const ids = docs.map((d) => d.id);
  const lines = await many<LineRow>(
    `SELECT document_id, line_json FROM forms_document_lines WHERE document_id = ANY($1::text[])`,
    [ids],
  );
  const byDoc = new Map<string, Record<string, string>[]>();
  for (const line of lines) {
    const list = byDoc.get(line.document_id) || [];
    list.push(parseJson(line.line_json));
    byDoc.set(line.document_id, list);
  }

  return docs.map((doc) => ({
    header: parseJson(doc.header_json),
    status: doc.status,
    lines: byDoc.get(doc.id) || [],
    created_at: doc.created_at,
  }));
}

async function loadProducts(companyOdooId?: string): Promise<Record<string, string>[]> {
  const params: unknown[] = ['product'];
  let sql = `SELECT header_json FROM forms_documents WHERE kind = $1`;
  if (companyOdooId) {
    params.push(companyOdooId);
    sql += ` AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`;
  }
  const rows = await many<{ header_json: string }>(sql, params);
  return rows.map((row) => parseJson(row.header_json));
}

function productUomByName(products: Record<string, string>[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of products) {
    const name = nameKey(header.name || '');
    const uom = String(header.uom || '').trim();
    if (name && uom) map.set(name, uom);
  }
  return map;
}

export type StockItem = { product: string; category: string; uom: string; qty: number };

const byProductName = (a: StockItem, b: StockItem) => a.product.localeCompare(b.product, 'pt-BR');
const m2oId = (value: unknown): number => (Array.isArray(value) ? Number(value[0]) || 0 : 0);
const m2oName = (value: unknown): string => (Array.isArray(value) ? String(value[1] || '') : '');

/** Estoque atual direto do Odoo: saldo dos locais internos (stock.quant), somado por produto. */
async function odooStock(companyOdooId?: string): Promise<StockItem[]> {
  const domain: unknown[] = [['quantity', '!=', 0], ['location_id.usage', '=', 'internal']];
  if (companyOdooId) domain.push(['company_id', '=', Number(companyOdooId)]);
  const quants = await odooSearchRead<{ product_id: unknown; quantity: number }>(
    'stock.quant',
    domain,
    ['product_id', 'quantity'],
    { limit: 10000 },
  );
  const qtyByVariant = new Map<number, { name: string; qty: number }>();
  for (const quant of quants) {
    const id = m2oId(quant.product_id);
    if (!id) continue;
    const entry = qtyByVariant.get(id) || { name: m2oName(quant.product_id), qty: 0 };
    entry.qty += Number(quant.quantity) || 0;
    qtyByVariant.set(id, entry);
  }
  if (!qtyByVariant.size) return [];
  const variants = await odooSearchRead<{ id: number; uom_id: unknown; categ_id: unknown }>(
    'product.product',
    [['id', 'in', [...qtyByVariant.keys()]]],
    ['id', 'uom_id', 'categ_id'],
    { limit: 10000 },
  );
  const info = new Map(variants.map((row) => [row.id, row]));
  return [...qtyByVariant.entries()]
    .map(([id, entry]) => ({
      product: entry.name,
      category: odooLabelPt(m2oName(info.get(id)?.categ_id)),
      uom: odooLabelPt(m2oName(info.get(id)?.uom_id)),
      qty: Math.round(entry.qty * 1000) / 1000,
    }))
    .filter((item) => item.qty !== 0)
    .sort(byProductName);
}

/** Estoque salvo na última sincronização (qty_on_hand); sem filtro de empresa soma por produto. */
function localStock(products: Record<string, string>[]): StockItem[] {
  const byKey = new Map<string, StockItem>();
  for (const header of products) {
    const product = String(header.name || '').trim();
    const qty = toOdooNumber(header.qty_on_hand, 0);
    if (!product || !qty) continue;
    const uom = String(header.uom || '').trim();
    const key = `${nameKey(product)}|${nameKey(uom)}`;
    const item = byKey.get(key);
    if (item) item.qty += qty;
    else byKey.set(key, { product, category: String(header.category || '').trim(), uom, qty });
  }
  return [...byKey.values()].filter((item) => item.qty !== 0).sort(byProductName);
}

export async function hubStockPayload(companyOdooId?: string) {
  if (odooConfigured()) {
    try {
      return { source: 'odoo', items: await odooStock(companyOdooId) };
    } catch (error) {
      console.warn('hub-stock: leitura do Odoo falhou, usando estoque salvo:', error instanceof Error ? error.message : error);
    }
  }
  return { source: 'local', items: localStock(await loadProducts(companyOdooId)) };
}

type Units = {
  uoms: UomInfo[];
  productUoms: Map<string, string>;
  kgPerBag: number;
};

/** Unidade da linha; vazia = unidade do produto no cadastro. */
function lineUom(line: Record<string, string>, units: Units): string {
  return String(line.uom || '').trim() || units.productUoms.get(nameKey(line.product || '')) || '';
}

/** Quantidade em kg; unidade vazia conta como kg. Unidades que não convertem (ex.: Unidades) → null. */
function kgOf(qty: number, uom: string, units: Units): number | null {
  if (!uom || isKgUnit(uom)) return qty;
  return toKg(qty, uom, units.uoms);
}

/** Quantidade em Bags: direto na unidade Bag, ou peso do produto Bag convertido pelo fator do Odoo. */
function bagsOf(qty: number, uom: string, units: Units): number | null {
  if (isBagUnit(uom)) return qty;
  const kg = kgOf(qty, uom, units);
  return kg != null && units.kgPerBag > 0 ? kg / units.kgPerBag : null;
}

class DailySeries {
  private readonly days: StackedDay[];
  private readonly products = new Set<string>();
  total = 0;

  constructor(
    year: number,
    month: number,
    private readonly unit: string,
  ) {
    this.days = Array.from({ length: daysInMonth(year, month) }, (_, i) => ({
      day: i + 1,
      label: dayLabel(i + 1),
      total: 0,
      byProduct: {},
    }));
  }

  add(date: Date, value: number, product = ''): void {
    if (!value) return;
    const slot = this.days[date.getDate() - 1];
    slot.total += value;
    if (product) {
      this.products.add(product);
      slot.byProduct[product] = (slot.byProduct[product] || 0) + value;
    }
    this.total += value;
  }

  build(stacked: boolean): DashboardSection {
    return {
      total: this.total,
      unit: this.unit,
      daily: this.days.map((day) => ({ label: day.label, value: day.total })),
      dailyStacked: stacked ? this.days : undefined,
      products: stacked ? [...this.products].sort((a, b) => a.localeCompare(b, 'pt-BR')) : [],
    };
  }
}

function buildReceipts(docs: LoadedDoc[], year: number, month: number, units: Units): DashboardSection {
  const series = new DailySeries(year, month, 'kg');
  for (const doc of docs) {
    if (isCancelled(doc)) continue;
    const date =
      parseDocDate(doc.header.order_deadline) ||
      parseDocDate(doc.header.expected_arrival) ||
      parseDocDate(doc.created_at);
    if (!inPeriod(date, year, month)) continue;
    for (const line of doc.lines) {
      const kg = kgOf(parseBrNumber(line.quantity), lineUom(line, units), units);
      if (kg) series.add(date, kg);
    }
  }
  return series.build(false);
}

function productionDate(doc: LoadedDoc): Date | null {
  return parseDocDate(doc.header.production_date) || parseDocDate(doc.created_at);
}

/** Separação: linhas geradas em Bag (unidade ou produto “Bag…”), contadas em bags. */
function buildSeparation(docs: LoadedDoc[], year: number, month: number, units: Units): DashboardSection {
  const series = new DailySeries(year, month, 'Bag');
  for (const doc of docs) {
    if (!isPostedProduction(doc)) continue;
    const date = productionDate(doc);
    if (!inPeriod(date, year, month)) continue;
    for (const line of doc.lines) {
      const product = String(line.product || '').trim();
      const uom = lineUom(line, units);
      if (isFardo(product) || !(isBagUnit(uom) || isBagProduct(product))) continue;
      const bags = bagsOf(parseBrNumber(line.quantity), uom, units);
      if (bags) series.add(date, bags, product || 'Bag');
    }
  }
  return series.build(true);
}

/** Prensagem: produtos FARDO gerados na Fabricação, em kg. */
function buildPressing(docs: LoadedDoc[], year: number, month: number, units: Units): DashboardSection {
  const series = new DailySeries(year, month, 'kg');
  for (const doc of docs) {
    if (!isPostedProduction(doc)) continue;
    const date = productionDate(doc);
    if (!inPeriod(date, year, month)) continue;
    for (const line of doc.lines) {
      const product = String(line.product || '').trim();
      if (!isFardo(product)) continue;
      const kg = kgOf(parseBrNumber(line.quantity), lineUom(line, units), units);
      if (kg) series.add(date, kg, product);
    }
  }
  return series.build(true);
}

function saleDate(doc: LoadedDoc): Date | null {
  return parseDocDate(doc.header.order_date) || parseDocDate(doc.created_at);
}

/** Entrega: produtos FARDO em vendas confirmadas, em kg. */
function buildDeliveries(docs: LoadedDoc[], year: number, month: number, units: Units): DashboardSection {
  const series = new DailySeries(year, month, 'kg');
  for (const doc of docs) {
    if (!isConfirmedSale(doc)) continue;
    const date = saleDate(doc);
    if (!inPeriod(date, year, month)) continue;
    for (const line of doc.lines) {
      const product = String(line.product || '').trim();
      if (!isFardo(product)) continue;
      const kg = kgOf(parseBrNumber(line.quantity), lineUom(line, units), units);
      if (kg) series.add(date, kg, product);
    }
  }
  return series.build(true);
}

/** Venda: valor (R$) das vendas confirmadas por dia. */
function buildSales(docs: LoadedDoc[], year: number, month: number): DashboardSection {
  const series = new DailySeries(year, month, 'R$');
  for (const doc of docs) {
    if (!isConfirmedSale(doc)) continue;
    const date = saleDate(doc);
    if (!inPeriod(date, year, month)) continue;
    for (const line of doc.lines) {
      series.add(date, parseBrNumber(line.quantity) * parseBrNumber(line.unit_price));
    }
  }
  return series.build(false);
}

export async function hubDashboardPayload(input: {
  year: number;
  month: number;
  companyOdooId?: string;
}) {
  const { year, month, companyOdooId } = input;
  const [purchases, productions, sales, products, uoms] = await Promise.all([
    loadKind('purchase', companyOdooId),
    loadKind('production', companyOdooId),
    loadKind('sale', companyOdooId),
    loadProducts(companyOdooId),
    listUomInfos(),
  ]);
  const units: Units = { uoms, productUoms: productUomByName(products), kgPerBag: toKg(1, 'Bag', uoms) || 0 };
  return {
    year,
    month,
    scope: companyOdooId ? 'entity' : 'all',
    receipts: buildReceipts(purchases, year, month, units),
    separation: buildSeparation(productions, year, month, units),
    pressing: buildPressing(productions, year, month, units),
    deliveries: buildDeliveries(sales, year, month, units),
    sales: buildSales(sales, year, month),
  };
}

export function registerHubDashboardRoutes(): void {
  route('GET', '/api/hub/dashboard', async (ctx: Ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;

    const now = new Date();
    const year = Number(ctx.query.get('year') || now.getFullYear());
    const month = Number(ctx.query.get('month') || now.getMonth() + 1);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      json(ctx.res, 400, { error: 'Ano inválido' });
      return;
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      json(ctx.res, 400, { error: 'Mês inválido' });
      return;
    }

    try {
      json(ctx.res, 200, await hubDashboardPayload({ year, month, companyOdooId: companyScope(ctx, user) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao montar dashboard';
      json(ctx.res, 500, { error: message });
    }
  });

  route('GET', '/api/hub/stock', async (ctx: Ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, await hubStockPayload(companyScope(ctx, user)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao carregar estoque';
      json(ctx.res, 500, { error: message });
    }
  });
}

type AuthUser = NonNullable<Awaited<ReturnType<typeof requireAuth>>>;

/**
 * ADM + Reciclarenda (id padrão): todas as empresas.
 * ADM + outra empresa: filtra. Gestor: só a empresa da conta.
 */
function companyScope(ctx: Ctx, user: AuthUser): string | undefined {
  if (isAdm(user)) {
    const activeId = String(ctx.query.get('companyId') || '').trim() || getActiveCompanyId();
    return activeId === DEFAULT_COMPANY_ODOO_ID ? undefined : activeId;
  }
  return String(user.companyOdooId || '').trim() || getActiveCompanyId();
}
