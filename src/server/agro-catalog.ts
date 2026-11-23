import { many } from './db.js';
import type { AgroBuyer, AgroProducer, AgroProduct, AgroProperty } from './agro-model.js';
import { listDeliveryPointBuyers } from './agro-delivery-points.js';
import { plotLabel } from './agro-resolve.js';

function nullable(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHeader(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value || {})) out[key] = item == null ? '' : String(item);
    return out;
  } catch {
    return {};
  }
}

export async function listAgroCatalog(companyId: string): Promise<{
  properties: AgroProperty[];
  farmProducers: AgroProducer[];
  products: AgroProduct[];
  producers: AgroBuyer[];
  buyers: AgroBuyer[];
}> {
  const farmProducerRows = await many<{
    id: string;
    name: string;
    total_area: number | null;
    city: string;
    state: string;
    phone: string;
    partner_id: string;
  }>(
    `SELECT id, name, total_area, city, state, phone, COALESCE(partner_id, '') AS partner_id
     FROM agro_producers
     WHERE company_odoo_id = $1 AND active = 1
     ORDER BY name ASC`,
    [companyId],
  );
  const properties = await many<{
    id: string;
    name: string;
    producer_id: string;
    producer_name: string;
  }>(
    `SELECT id, name, COALESCE(producer_id, '') AS producer_id, producer_name
     FROM agro_properties
     WHERE company_odoo_id = $1 AND active = 1 ORDER BY name ASC`,
    [companyId],
  );
  const propertyIds = properties.map((item) => item.id);
  const plots = propertyIds.length
    ? await many<{ id: string; property_id: string; code: string; name: string; area: number | null }>(
        `SELECT id, property_id, COALESCE(code, '') AS code, name, area FROM agro_plots
         WHERE active = 1 AND property_id = ANY($1::text[])
         ORDER BY CASE WHEN COALESCE(code, '') = '' THEN 1 ELSE 0 END, lower(code), lower(name)`,
        [propertyIds],
      )
    : [];
  const productRows = await many<{ id: string; header_json: string }>(
    `SELECT id, header_json FROM forms_documents
     WHERE kind = 'product' AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
     ORDER BY updated_at DESC`,
    [companyId],
  );
  const products: AgroProduct[] = [];
  const seen = new Set<string>();
  for (const row of productRows) {
    const header = parseHeader(row.header_json);
    const name = header.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({
      id: row.id,
      name,
      sigla: header.sigla || '',
      uom: header.uom || '',
      salesPrice: header.sales_price || '',
      cycleDays: nullable(header.cycle_days),
      yieldPerHa: nullable(header.yield_per_ha),
    });
  }
  products.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const buyers = await listDeliveryPointBuyers(companyId);
  const producers = await many<AgroBuyer>(
    `SELECT DISTINCT ON (lower(name)) id, name FROM forms_partners
     WHERE is_vendor = 1 AND (company_odoo_id = $1 OR company_odoo_id = '0')
     ORDER BY lower(name), CASE WHEN company_odoo_id = $1 THEN 0 ELSE 1 END, name ASC`,
    [companyId],
  );
  producers.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const mappedProperties: AgroProperty[] = properties.map((property) => ({
    id: property.id,
    name: property.name,
    producerId: property.producer_id || '',
    producerName: property.producer_name || '',
    plots: plots
      .filter((plot) => plot.property_id === property.id)
      .map((plot) => ({
        id: plot.id,
        code: plot.code || '',
        name: plot.name,
        area: nullable(plot.area),
        label: plotLabel(plot.code, plot.name),
      })),
  }));
  const farmProducers: AgroProducer[] = farmProducerRows.map((producer) => ({
    id: producer.id,
    name: producer.name,
    totalArea: nullable(producer.total_area),
    city: producer.city || '',
    state: producer.state || '',
    phone: producer.phone || '',
    partnerId: producer.partner_id || '',
    properties: mappedProperties.filter((property) => property.producerId === producer.id),
  }));
  return {
    properties: mappedProperties,
    farmProducers,
    products,
    producers,
    buyers,
  };
}
