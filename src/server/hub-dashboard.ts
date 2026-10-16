import { many } from './db.js';
import { json, route, type Ctx } from './http.js';
import { requireAuth } from './auth.js';
import { DEFAULT_COMPANY_ODOO_ID, getActiveCompanyId } from './forms-companies.js';
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

type SeriesPoint = { label: string; value: number };
type StackedDay = { day: number; label: string; total: number; byProduct: Record<string, number> };

export type DashboardSection = {
  total: number;
  /** Unidade principal (ex.: kg). */
  unit?: string;
  /** Total formatável com unidade(s), ex.: "1.234 kg". */
  totalLabel?: string;
  daily: SeriesPoint[];
  dailyStacked?: StackedDay[];
  products: string[];
  breakdown: SeriesPoint[];
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

function emptyDaily(year: number, month: number): SeriesPoint[] {
  const days = daysInMonth(year, month);
  return Array.from({ length: days }, (_, i) => ({
    label: String(i + 1).padStart(2, '0'),
    value: 0,
  }));
}

function emptyStacked(year: number, month: number): StackedDay[] {
  const days = daysInMonth(year, month);
  return Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    label: String(i + 1).padStart(2, '0'),
    total: 0,
    byProduct: {},
  }));
}

function isCancelled(status: string, header: Record<string, string>): boolean {
  const state = String(header.odoo_state || status || '').toLowerCase();
  return state === 'cancel' || state === 'cancelled' || state === 'canceled';
}

async function loadKind(kind: 'purchase' | 'sale', companyOdooId?: string) {
  const params: unknown[] = [kind];
  let sql = `SELECT id, status, header_json, company_odoo_id, created_at
    FROM forms_documents WHERE kind = $1`;
  if (companyOdooId) {
    params.push(companyOdooId);
    sql += ` AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`;
  }
  const docs = await many<DocRow>(sql, params);
  type LoadedDoc = {
    header: Record<string, string>;
    status: string;
    lines: Record<string, string>[];
    created_at: string;
  };
  if (!docs.length) return [] as LoadedDoc[];

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

function inPeriod(date: Date | null, year: number, month: number): boolean {
  if (!date) return false;
  return date.getFullYear() === year && date.getMonth() + 1 === month;
}

function topBreakdown(map: Map<string, number>, limit = 12): SeriesPoint[] {
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function nameKey(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

async function productUomByName(companyOdooId?: string): Promise<Map<string, string>> {
  const params: unknown[] = ['product'];
  let sql = `SELECT header_json FROM forms_documents WHERE kind = $1`;
  if (companyOdooId) {
    params.push(companyOdooId);
    sql += ` AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`;
  }
  const rows = await many<{ header_json: string }>(sql, params);
  const map = new Map<string, string>();
  for (const row of rows) {
    const header = parseJson(row.header_json);
    const name = nameKey(header.name || '');
    const uom = String(header.uom || '').trim();
    if (name && uom) map.set(name, uom);
  }
  return map;
}

function formatTotalByUnit(byUom: Map<string, number>): { unit: string; totalLabel: string; total: number } {
  const entries = [...byUom.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!entries.length) return { unit: '', totalLabel: '0', total: 0 };
  const unit = entries[0][0];
  const totalLabel = entries
    .map(([uom, value]) => {
      const qty = value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
      return uom ? `${qty} ${uom}` : qty;
    })
    .join(' · ');
  return { unit, totalLabel, total };
}

async function buildReceipts(year: number, month: number, companyOdooId?: string): Promise<DashboardSection> {
  const [docs, uomMap] = await Promise.all([
    loadKind('purchase', companyOdooId),
    productUomByName(companyOdooId),
  ]);
  const daily = emptyDaily(year, month);
  const byCatador = new Map<string, number>();
  const byUom = new Map<string, number>();
  let total = 0;

  for (const doc of docs) {
    if (isCancelled(doc.status, doc.header)) continue;
    const date =
      parseDocDate(doc.header.order_deadline) ||
      parseDocDate(doc.header.expected_arrival) ||
      parseDocDate(doc.created_at);
    if (!inPeriod(date, year, month) || !date) continue;
    const day = date.getDate();
    const vendor = String(doc.header.vendor || '').trim() || 'Sem catador';
    let docQty = 0;
    for (const line of doc.lines) {
      const qty = parseBrNumber(line.quantity);
      if (!qty) continue;
      const productName = String(line.product || '').trim();
      const uom =
        String(line.uom || '').trim() ||
        uomMap.get(nameKey(productName)) ||
        'kg';
      docQty += qty;
      byCatador.set(vendor, (byCatador.get(vendor) || 0) + qty);
      byUom.set(uom, (byUom.get(uom) || 0) + qty);
    }
    if (!docQty) continue;
    daily[day - 1].value += docQty;
    total += docQty;
  }

  const units = formatTotalByUnit(byUom);
  return {
    total: units.total || total,
    unit: units.unit,
    totalLabel: units.totalLabel,
    daily,
    breakdown: topBreakdown(byCatador),
    products: [],
  };
}

async function buildSales(year: number, month: number, companyOdooId?: string): Promise<DashboardSection> {
  const docs = await loadKind('sale', companyOdooId);
  const dailyStacked = emptyStacked(year, month);
  const byProduct = new Map<string, number>();
  const productSet = new Set<string>();
  let total = 0;

  for (const doc of docs) {
    if (isCancelled(doc.status, doc.header)) continue;
    const date = parseDocDate(doc.header.order_date) || parseDocDate(doc.created_at);
    if (!inPeriod(date, year, month) || !date) continue;
    const day = date.getDate();
    for (const line of doc.lines) {
      const product = String(line.product || '').trim() || 'Sem produto';
      const qty = parseBrNumber(line.quantity);
      const price = parseBrNumber(line.unit_price);
      const amount = qty * price;
      if (!amount) continue;
      productSet.add(product);
      dailyStacked[day - 1].byProduct[product] = (dailyStacked[day - 1].byProduct[product] || 0) + amount;
      dailyStacked[day - 1].total += amount;
      byProduct.set(product, (byProduct.get(product) || 0) + amount);
      total += amount;
    }
  }

  const products = [...productSet].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const daily = dailyStacked.map((item) => ({ label: item.label, value: item.total }));
  return { total, daily, dailyStacked, products, breakdown: topBreakdown(byProduct) };
}

/**
 * Produção ainda não tem documento dedicado no Vertice.
 * Mantém o mesmo contrato da UI; retorna série vazia até existir a fonte.
 */
async function buildProduction(year: number, month: number, _companyOdooId?: string): Promise<DashboardSection> {
  return {
    total: 0,
    daily: emptyDaily(year, month),
    dailyStacked: emptyStacked(year, month),
    products: [],
    breakdown: [],
  };
}

export async function hubDashboardPayload(input: {
  year: number;
  month: number;
  companyOdooId?: string;
}) {
  const { year, month, companyOdooId } = input;
  const [receipts, production, sales] = await Promise.all([
    buildReceipts(year, month, companyOdooId),
    buildProduction(year, month, companyOdooId),
    buildSales(year, month, companyOdooId),
  ]);
  return {
    year,
    month,
    scope: companyOdooId ? 'entity' : 'all',
    receipts,
    production,
    sales,
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

    // ADM + Reciclarenda (id padrão): todas as empresas.
    // ADM + outra empresa: filtra. Gestor: só a empresa da conta.
    const fromQuery = String(ctx.query.get('companyId') || '').trim();
    let companyOdooId: string | undefined;
    if (isAdm(user)) {
      const activeId = fromQuery || getActiveCompanyId();
      companyOdooId = activeId === DEFAULT_COMPANY_ODOO_ID ? undefined : activeId;
    } else {
      companyOdooId = String(user.companyOdooId || '').trim() || getActiveCompanyId();
    }
    try {
      json(ctx.res, 200, await hubDashboardPayload({ year, month, companyOdooId }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao montar dashboard';
      json(ctx.res, 500, { error: message });
    }
  });
}
