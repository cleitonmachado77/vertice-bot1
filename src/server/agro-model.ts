import { many, one } from './db.js';

export type AgroPlot = { id: string; code: string; name: string; area: number | null; label: string };

/** Expressão SQL do rótulo do talhão (código · nome). */
export const PLOT_LABEL_SQL = `
  CASE
    WHEN COALESCE(pl.code, '') <> '' AND lower(pl.code) <> lower(pl.name)
      THEN pl.code || ' · ' || pl.name
    WHEN COALESCE(pl.code, '') <> '' THEN pl.code
    ELSE COALESCE(pl.name, '')
  END
`.trim();
export type AgroProperty = {
  id: string;
  name: string;
  producerId: string;
  producerName: string;
  plots: AgroPlot[];
};
export type AgroProducer = {
  id: string;
  name: string;
  totalArea: number | null;
  city: string;
  state: string;
  phone: string;
  partnerId: string;
  properties: AgroProperty[];
};
export type AgroProduct = {
  id: string;
  name: string;
  sigla: string;
  uom: string;
  salesPrice: string;
  cycleDays: number | null;
  yieldPerHa: number | null;
};
export type AgroBuyer = { id: string; name: string };

export type AgroPlanting = {
  id: string;
  propertyId: string;
  propertyName: string;
  producerPartnerId: string;
  producerName: string;
  plotId: string;
  plotName: string;
  productId: string;
  productName: string;
  unit: string;
  areaPlanned: number;
  plantedOn: string;
  forecastOn: string;
  forecastQty: number | null;
  notes: string;
  status: string;
  harvestedQty: number;
  deliveredQty: number;
  deliveredValue: number;
};

export type AgroHarvest = {
  id: string;
  plantingId: string;
  harvestedOn: string;
  quantity: number;
  notes: string;
  productName: string;
  unit: string;
  propertyName: string;
  plotName: string;
  plantingStatus: string;
};

export type AgroDelivery = {
  id: string;
  plantingId: string;
  partnerId: string;
  partnerName: string;
  deliveredOn: string;
  quantity: number;
  unitPrice: number | null;
  totalValue: number | null;
  document: string;
  notes: string;
  saleDocumentId: string;
  odooOrderId: string;
  odooOrderRef: string;
  productName: string;
  unit: string;
  propertyName: string;
  plotName: string;
  plotId: string;
};

type PlantingRow = {
  id: string;
  property_id: string;
  property_name: string;
  producer_partner_id: string;
  producer_name: string;
  plot_id: string;
  plot_name: string;
  product_id: string;
  product_name: string;
  unit: string;
  area_planned: number;
  planted_on: string;
  forecast_on: string;
  forecast_qty: number | null;
  notes: string;
  status: string;
  harvested_qty: number;
  delivered_qty: number;
  delivered_value: number;
};

const PLANTING_SQL = `
  SELECT p.id, p.property_id, pr.name AS property_name,
    COALESCE(pr.producer_partner_id, '') AS producer_partner_id, pr.producer_name,
    COALESCE(p.plot_id, '') AS plot_id, ${PLOT_LABEL_SQL} AS plot_name,
    p.product_id, p.product_name, p.unit, p.area_planned,
    to_char(p.planted_on, 'YYYY-MM-DD') AS planted_on,
    COALESCE(to_char(p.forecast_on, 'YYYY-MM-DD'), '') AS forecast_on,
    p.forecast_qty, p.notes, p.status,
    COALESCE(h.qty, 0) AS harvested_qty,
    COALESCE(d.qty, 0) AS delivered_qty,
    COALESCE(d.total, 0) AS delivered_value
  FROM agro_plantings p
  JOIN agro_properties pr ON pr.id = p.property_id
  LEFT JOIN agro_plots pl ON pl.id = p.plot_id
  LEFT JOIN (
    SELECT planting_id, SUM(quantity) AS qty FROM agro_harvests GROUP BY planting_id
  ) h ON h.planting_id = p.id
  LEFT JOIN (
    SELECT planting_id, SUM(quantity) AS qty, SUM(total_value) AS total
    FROM agro_deliveries GROUP BY planting_id
  ) d ON d.planting_id = p.id
`;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullable(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapPlanting(row: PlantingRow): AgroPlanting {
  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    producerPartnerId: row.producer_partner_id || '',
    producerName: row.producer_name || '',
    plotId: row.plot_id || '',
    plotName: row.plot_name || '',
    productId: row.product_id || '',
    productName: row.product_name,
    unit: row.unit || '',
    areaPlanned: num(row.area_planned),
    plantedOn: row.planted_on,
    forecastOn: row.forecast_on || '',
    forecastQty: nullable(row.forecast_qty),
    notes: row.notes || '',
    status: row.status,
    harvestedQty: num(row.harvested_qty),
    deliveredQty: num(row.delivered_qty),
    deliveredValue: num(row.delivered_value),
  };
}

export async function listPlantings(companyId: string): Promise<AgroPlanting[]> {
  const rows = await many<PlantingRow>(
    `${PLANTING_SQL} WHERE p.company_odoo_id = $1 ORDER BY p.planted_on DESC, pr.name ASC`,
    [companyId],
  );
  return rows.map(mapPlanting);
}

export async function getPlanting(companyId: string, id: string): Promise<AgroPlanting | undefined> {
  const row = await one<PlantingRow>(`${PLANTING_SQL} WHERE p.company_odoo_id = $1 AND p.id = $2`, [
    companyId,
    id,
  ]);
  return row ? mapPlanting(row) : undefined;
}

export async function listHarvests(companyId: string): Promise<AgroHarvest[]> {
  const rows = await many<{
    id: string;
    planting_id: string;
    harvested_on: string;
    quantity: number;
    notes: string;
    product_name: string;
    unit: string;
    property_name: string;
    plot_name: string;
    planting_status: string;
  }>(
    `SELECT h.id, h.planting_id, to_char(h.harvested_on, 'YYYY-MM-DD') AS harvested_on,
       h.quantity, h.notes, p.product_name, p.unit, pr.name AS property_name,
       ${PLOT_LABEL_SQL} AS plot_name, p.status AS planting_status
     FROM agro_harvests h
     JOIN agro_plantings p ON p.id = h.planting_id
     JOIN agro_properties pr ON pr.id = p.property_id
     LEFT JOIN agro_plots pl ON pl.id = p.plot_id
     WHERE p.company_odoo_id = $1
     ORDER BY h.harvested_on DESC, h.created_at DESC`,
    [companyId],
  );
  return rows.map((row) => ({
    id: row.id,
    plantingId: row.planting_id,
    harvestedOn: row.harvested_on,
    quantity: num(row.quantity),
    notes: row.notes || '',
    productName: row.product_name,
    unit: row.unit || '',
    propertyName: row.property_name,
    plotName: row.plot_name || '',
    plantingStatus: row.planting_status,
  }));
}

export async function getHarvest(companyId: string, id: string): Promise<AgroHarvest | undefined> {
  const items = await listHarvests(companyId);
  return items.find((item) => item.id === id);
}

export async function listDeliveries(companyId: string): Promise<AgroDelivery[]> {
  const rows = await many<{
    id: string;
    planting_id: string;
    partner_id: string;
    partner_name: string;
    delivered_on: string;
    quantity: number;
    unit_price: number | null;
    total_value: number | null;
    document: string;
    notes: string;
    sale_document_id: string;
    odoo_order_id: string;
    odoo_order_ref: string;
    product_name: string;
    unit: string;
    property_name: string;
    plot_name: string;
    plot_id: string;
  }>(
    `SELECT e.id, e.planting_id, e.partner_id, e.partner_name,
       to_char(e.delivered_on, 'YYYY-MM-DD') AS delivered_on,
       e.quantity, e.unit_price, e.total_value, e.document, e.notes,
       COALESCE(e.sale_document_id, '') AS sale_document_id,
       COALESCE(e.odoo_order_id, '') AS odoo_order_id,
       COALESCE(e.odoo_order_ref, '') AS odoo_order_ref,
       p.product_name, p.unit, pr.name AS property_name, ${PLOT_LABEL_SQL} AS plot_name,
       COALESCE(p.plot_id, '') AS plot_id
     FROM agro_deliveries e
     JOIN agro_plantings p ON p.id = e.planting_id
     JOIN agro_properties pr ON pr.id = p.property_id
     LEFT JOIN agro_plots pl ON pl.id = p.plot_id
     WHERE p.company_odoo_id = $1
     ORDER BY e.delivered_on DESC, e.created_at DESC`,
    [companyId],
  );
  return rows.map((row) => ({
    id: row.id,
    plantingId: row.planting_id,
    partnerId: row.partner_id || '',
    partnerName: row.partner_name,
    deliveredOn: row.delivered_on,
    quantity: num(row.quantity),
    unitPrice: nullable(row.unit_price),
    totalValue: nullable(row.total_value),
    document: row.document || '',
    notes: row.notes || '',
    saleDocumentId: row.sale_document_id || '',
    odooOrderId: row.odoo_order_id || '',
    odooOrderRef: row.odoo_order_ref || '',
    productName: row.product_name,
    unit: row.unit || '',
    propertyName: row.property_name,
    plotName: row.plot_name || '',
    plotId: row.plot_id || '',
  }));
}

export async function getDelivery(companyId: string, id: string): Promise<AgroDelivery | undefined> {
  const items = await listDeliveries(companyId);
  return items.find((item) => item.id === id);
}

