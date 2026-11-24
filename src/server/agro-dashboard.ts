import { listCosts } from './agro-costs.js';
import { listDeliveries, listHarvests, listPlantings } from './agro-model.js';
import { ensureAgroSchema } from './agro-schema.js';
import { many } from './db.js';
import { listCompanies } from './forms-companies.js';

export type AgroDashBar = { label: string; value: number; unit?: string };
export type AgroDashSeries = { label: string; revenue: number; expense: number };
export type AgroDashboardPayload = Awaited<ReturnType<typeof agroDashboard>>;

function inPeriod(iso: string, month: number, year: number): boolean {
  if (!iso || iso.length < 7) return false;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return y === year && m === month;
}

function productLabel(name: string, sigla: string): string {
  return (sigla || name || '—').trim() || '—';
}

function parseProductHeader(raw: string): { sigla: string; salesPrice: number } {
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    const sigla = value.sigla == null ? '' : String(value.sigla).trim();
    const salesPrice = Number(String(value.sales_price ?? '').replace(',', '.')) || 0;
    return { sigla, salesPrice };
  } catch {
    return { sigla: '', salesPrice: 0 };
  }
}

/** Só metadados dos produtos usados nos plantios — evita varrer o catálogo inteiro (~250+). */
async function loadProductMeta(productIds: string[]) {
  const ids = [...new Set(productIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const siglaByProductId = new Map<string, string>();
  const salesPriceByProductId = new Map<string, number>();
  if (!ids.length) return { siglaByProductId, salesPriceByProductId };

  const rows = await many<{ id: string; header_json: string }>(
    `SELECT id, header_json FROM forms_documents
     WHERE kind = 'product' AND id = ANY($1::text[])`,
    [ids],
  );
  for (const row of rows) {
    const header = parseProductHeader(row.header_json);
    siglaByProductId.set(row.id, header.sigla);
    salesPriceByProductId.set(row.id, header.salesPrice);
  }
  return { siglaByProductId, salesPriceByProductId };
}

function addMap(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) || 0) + value);
}

function barsFromMap(map: Map<string, number>, unit = ''): AgroDashBar[] {
  return [...map.entries()]
    .map(([label, value]) => ({ label, value: Math.round(value * 1000) / 1000, unit }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'pt-BR'));
}

function isActivePlanting(status: string): boolean {
  return status !== 'colhido';
}

export async function agroDashboard(
  companyId: string,
  month: number,
  year: number,
  productId = '',
) {
  await ensureAgroSchema();
  const now = new Date();
  const periodMonth = month >= 1 && month <= 12 ? month : now.getMonth() + 1;
  const periodYear = year >= 2000 && year <= 2100 ? year : now.getFullYear();
  const selectedProductId = String(productId || '').trim();

  const [plantings, harvests, deliveries, costs] = await Promise.all([
    listPlantings(companyId),
    listHarvests(companyId),
    listDeliveries(companyId),
    listCosts(companyId),
  ]);
  const { siglaByProductId, salesPriceByProductId } = await loadProductMeta(
    plantings.map((item) => item.productId),
  );

  const matchProduct = (id: string) => !selectedProductId || id === selectedProductId;

  const labelOf = (id: string, productName: string) =>
    productLabel(productName, siglaByProductId.get(id) || '');

  const plantingById = new Map(plantings.map((item) => [item.id, item]));

  /** Talhões com plantio da cultura filtrada (custos / receita por área). */
  const plotIdsForProduct = new Set(
    plantings.filter((item) => matchProduct(item.productId)).map((item) => item.plotId).filter(Boolean),
  );
  const matchPlot = (plotId: string) =>
    !selectedProductId || (plotId && plotIdsForProduct.has(plotId));

  const avgPriceByProduct = new Map<string, { value: number; qty: number }>();
  for (const item of deliveries) {
    if (!inPeriod(item.deliveredOn, periodMonth, periodYear)) continue;
    const planting = plantingById.get(item.plantingId);
    if (!matchProduct(planting?.productId || '')) continue;
    const key = item.productName || item.plantingId;
    const bucket = avgPriceByProduct.get(key) || { value: 0, qty: 0 };
    bucket.value += Number(item.totalValue || 0);
    bucket.qty += Number(item.quantity || 0);
    avgPriceByProduct.set(key, bucket);
  }

  function avgSalePrice(id: string, productName: string): number {
    const bucket = avgPriceByProduct.get(productName);
    if (bucket && bucket.qty > 0) return bucket.value / bucket.qty;
    return salesPriceByProductId.get(id) || 0;
  }

  const forecastByProduct = new Map<string, number>();
  const forecastTimeline: Array<{ product: string; date: string; qty: number }> = [];
  const plantingByProduct = new Map<string, number>();
  const harvestByProduct = new Map<string, number>();
  const deliveryByProduct = new Map<string, number>();
  const salesByProduct = new Map<string, number>();
  const stockByProduct = new Map<string, number>();
  const costsByArea = new Map<string, number>();
  const revenueByArea = new Map<string, number>();
  const expenseByArea = new Map<string, number>();

  let plantedAreaHa = 0;
  let estimatedQty = 0;

  for (const item of plantings) {
    if (!matchProduct(item.productId)) continue;
    const label = labelOf(item.productId, item.productName);

    if (isActivePlanting(item.status)) {
      plantedAreaHa += Number(item.areaPlanned || 0);
      estimatedQty += Number(item.forecastQty || 0);
      // Mesma base do KPI: estimativa dos plantios ativos (não só forecastOn no mês).
      if (Number(item.forecastQty || 0) > 0) {
        addMap(forecastByProduct, label, Number(item.forecastQty || 0));
      }
    }

    if (inPeriod(item.plantedOn, periodMonth, periodYear)) {
      const planted = Number(item.plantedQty ?? item.forecastQty ?? 0);
      if (planted > 0) addMap(plantingByProduct, label, planted);
    }
    if (item.forecastQty != null && item.forecastOn && inPeriod(item.forecastOn, periodMonth, periodYear)) {
      forecastTimeline.push({
        product: label,
        date: item.forecastOn,
        qty: Number(item.forecastQty || 0),
      });
    }
    const stock = Number(item.harvestedQty || 0) - Number(item.deliveredQty || 0);
    if (stock > 0.0001) addMap(stockByProduct, label, stock);
  }

  let harvestedQty = 0;
  for (const item of harvests) {
    if (!inPeriod(item.harvestedOn, periodMonth, periodYear)) continue;
    const planting = plantingById.get(item.plantingId);
    if (!matchProduct(planting?.productId || '')) continue;
    const qty = Number(item.quantity || 0);
    harvestedQty += qty;
    const label = labelOf(planting?.productId || '', item.productName);
    addMap(harvestByProduct, label, qty);
    const area = item.plotName || planting?.plotName || 'Sem talhão';
    const price = avgSalePrice(planting?.productId || '', item.productName);
    addMap(revenueByArea, area, qty * price);
  }

  let deliveredQty = 0;
  let soldValue = 0;
  for (const item of deliveries) {
    if (!inPeriod(item.deliveredOn, periodMonth, periodYear)) continue;
    const planting = plantingById.get(item.plantingId);
    if (!matchProduct(planting?.productId || '')) continue;
    const qty = Number(item.quantity || 0);
    const value = Number(item.totalValue || 0);
    deliveredQty += qty;
    soldValue += value;
    const label = labelOf(planting?.productId || '', item.productName);
    addMap(deliveryByProduct, label, qty);
    addMap(salesByProduct, label, value);
  }

  let productionCosts = 0;
  for (const item of costs) {
    if (!inPeriod(item.costOn, periodMonth, periodYear)) continue;
    if (!matchPlot(item.plotId)) continue;
    const area = item.plotName || 'Sem talhão';
    const amount = item.totalValue != null ? item.totalValue : Number(item.quantity || 0);
    productionCosts += amount;
    addMap(costsByArea, area, amount);
    addMap(expenseByArea, area, amount);
  }

  const areaKeys = new Set([...revenueByArea.keys(), ...expenseByArea.keys()]);
  const revenueExpenseByArea: AgroDashSeries[] = [...areaKeys]
    .map((label) => ({
      label,
      revenue: Math.round((revenueByArea.get(label) || 0) * 100) / 100,
      expense: Math.round((expenseByArea.get(label) || 0) * 100) / 100,
    }))
    .sort((a, b) => b.revenue - a.revenue || a.label.localeCompare(b.label, 'pt-BR'));

  // Filtro só com culturas que têm plantio nesta empresa (não o catálogo inteiro).
  const productOptions = new Map<string, { id: string; name: string; sigla: string; label: string }>();
  for (const item of plantings) {
    if (!item.productId || productOptions.has(item.productId)) continue;
    productOptions.set(item.productId, {
      id: item.productId,
      name: item.productName,
      sigla: siglaByProductId.get(item.productId) || '',
      label: labelOf(item.productId, item.productName),
    });
  }

  return {
    companyId,
    period: { month: periodMonth, year: periodYear },
    productId: selectedProductId,
    products: [...productOptions.values()].sort((a, b) =>
      a.label.localeCompare(b.label, 'pt-BR'),
    ),
    summary: {
      plantedAreaHa: Math.round(plantedAreaHa * 1000) / 1000,
      estimatedQty: Math.round(estimatedQty * 1000) / 1000,
      harvestedQty: Math.round(harvestedQty * 1000) / 1000,
      deliveredQty: Math.round(deliveredQty * 1000) / 1000,
      soldValue: Math.round(soldValue * 100) / 100,
      costs: Math.round(productionCosts * 100) / 100,
    },
    forecast: {
      byProduct: barsFromMap(forecastByProduct),
      timeline: forecastTimeline.sort(
        (a, b) => a.date.localeCompare(b.date) || a.product.localeCompare(b.product),
      ),
    },
    plantingByProduct: barsFromMap(plantingByProduct),
    harvestByProduct: barsFromMap(harvestByProduct),
    deliveryByProduct: barsFromMap(deliveryByProduct),
    salesByProduct: barsFromMap(salesByProduct, 'R$'),
    stockByProduct: barsFromMap(stockByProduct),
    costsByArea: barsFromMap(costsByArea, 'R$'),
    revenueExpenseByArea,
  };
}

function mergeBars(target: Map<string, number>, bars: AgroDashBar[]) {
  for (const bar of bars) addMap(target, bar.label, Number(bar.value || 0));
}

function emptyAgroSummary() {
  return {
    plantedAreaHa: 0,
    estimatedQty: 0,
    harvestedQty: 0,
    deliveredQty: 0,
    soldValue: 0,
    costs: 0,
  };
}

/**
 * Agro no hub Recicla Renda: consolida todas as empresas com plantio,
 * ou filtra por companyOdooId quando o escopo é de uma entidade.
 */
export async function hubAgroDashboard(
  month: number,
  year: number,
  companyOdooId?: string,
): Promise<{
  period: { month: number; year: number };
  scope: 'all' | 'entity';
  summary: ReturnType<typeof emptyAgroSummary>;
  plantingByProduct: AgroDashBar[];
  harvestByProduct: AgroDashBar[];
  deliveryByProduct: AgroDashBar[];
  costsByArea: AgroDashBar[];
  byCompany: Array<{
    companyId: string;
    companyName: string;
    summary: ReturnType<typeof emptyAgroSummary>;
    plantingByProduct: AgroDashBar[];
    harvestByProduct: AgroDashBar[];
    deliveryByProduct: AgroDashBar[];
  }>;
}> {
  await ensureAgroSchema();
  const now = new Date();
  const periodMonth = month >= 1 && month <= 12 ? month : now.getMonth() + 1;
  const periodYear = year >= 2000 && year <= 2100 ? year : now.getFullYear();

  const companies = await listCompanies();
  const nameById = new Map(companies.map((item) => [item.id, item.name]));
  let companyIds: string[];
  if (companyOdooId) {
    companyIds = [companyOdooId];
  } else {
    const rows = await many<{ company_odoo_id: string }>(
      `SELECT DISTINCT company_odoo_id FROM agro_plantings WHERE COALESCE(company_odoo_id, '') <> ''`,
    );
    companyIds = rows.map((row) => row.company_odoo_id);
  }

  const summary = emptyAgroSummary();
  const plantingMap = new Map<string, number>();
  const harvestMap = new Map<string, number>();
  const deliveryMap = new Map<string, number>();
  const costsMap = new Map<string, number>();
  const byCompany: Array<{
    companyId: string;
    companyName: string;
    summary: ReturnType<typeof emptyAgroSummary>;
    plantingByProduct: AgroDashBar[];
    harvestByProduct: AgroDashBar[];
    deliveryByProduct: AgroDashBar[];
  }> = [];

  for (const companyId of companyIds) {
    const dash = await agroDashboard(companyId, periodMonth, periodYear);
    const companyName = nameById.get(companyId) || `Empresa ${companyId}`;
    summary.plantedAreaHa += dash.summary.plantedAreaHa;
    summary.estimatedQty += dash.summary.estimatedQty;
    summary.harvestedQty += dash.summary.harvestedQty;
    summary.deliveredQty += dash.summary.deliveredQty;
    summary.soldValue += dash.summary.soldValue;
    summary.costs += dash.summary.costs;
    mergeBars(plantingMap, dash.plantingByProduct);
    mergeBars(harvestMap, dash.harvestByProduct);
    mergeBars(deliveryMap, dash.deliveryByProduct);
    for (const bar of dash.costsByArea) {
      addMap(costsMap, `${shortCompanyName(companyName)} · ${bar.label}`, Number(bar.value || 0));
    }
    byCompany.push({
      companyId,
      companyName,
      summary: dash.summary,
      plantingByProduct: dash.plantingByProduct,
      harvestByProduct: dash.harvestByProduct,
      deliveryByProduct: dash.deliveryByProduct,
    });
  }

  byCompany.sort((a, b) => a.companyName.localeCompare(b.companyName, 'pt-BR'));

  return {
    period: { month: periodMonth, year: periodYear },
    scope: companyOdooId ? 'entity' : 'all',
    summary: {
      plantedAreaHa: Math.round(summary.plantedAreaHa * 1000) / 1000,
      estimatedQty: Math.round(summary.estimatedQty * 1000) / 1000,
      harvestedQty: Math.round(summary.harvestedQty * 1000) / 1000,
      deliveredQty: Math.round(summary.deliveredQty * 1000) / 1000,
      soldValue: Math.round(summary.soldValue * 100) / 100,
      costs: Math.round(summary.costs * 100) / 100,
    },
    plantingByProduct: barsFromMap(plantingMap),
    harvestByProduct: barsFromMap(harvestMap),
    deliveryByProduct: barsFromMap(deliveryMap),
    costsByArea: barsFromMap(costsMap, 'R$'),
    byCompany,
  };
}

function shortCompanyName(name: string): string {
  const text = String(name || '').trim();
  if (/coara/i.test(text)) return 'COARA';
  if (/recicla/i.test(text)) return 'Reciclarenda';
  const dash = text.split(' - ')[0]?.trim();
  return (dash || text).slice(0, 28);
}
