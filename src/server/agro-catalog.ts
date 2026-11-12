import { many } from './db.js';
import type { AgroBuyer, AgroProduct, AgroProperty } from './agro-model.js';

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
  products: AgroProduct[];
  producers: AgroBuyer[];
  buyers: AgroBuyer[];
}> {
  const properties = await many<{ id: string; name: string; producer_name: string }>(
    `SELECT id, name, producer_name FROM agro_properties
     WHERE company_odoo_id = $1 AND active = 1 ORDER BY name ASC`,
    [companyId],
  );
  const propertyIds = properties.map((item) => item.id);
  const plots = propertyIds.length
    ? await many<{ id: string; property_id: string; name: string; area: number | null }>(
        `SELECT id, property_id, name, area FROM agro_plots
         WHERE active = 1 AND property_id = ANY($1::text[])
         ORDER BY name ASC`,
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
    products.push({ id: row.id, name, uom: header.uom || '', salesPrice: header.sales_price || '' });
  }
  products.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const buyers = await many<AgroBuyer>(
    `SELECT DISTINCT ON (lower(name)) id, name FROM forms_partners
     WHERE is_customer = 1 AND (company_odoo_id = $1 OR company_odoo_id = '0')
     ORDER BY lower(name), CASE WHEN company_odoo_id = $1 THEN 0 ELSE 1 END, name ASC`,
    [companyId],
  );
  const producers = await many<AgroBuyer>(
    `SELECT DISTINCT ON (lower(name)) id, name FROM forms_partners
     WHERE is_vendor = 1 AND (company_odoo_id = $1 OR company_odoo_id = '0')
     ORDER BY lower(name), CASE WHEN company_odoo_id = $1 THEN 0 ELSE 1 END, name ASC`,
    [companyId],
  );
  buyers.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  producers.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return {
    properties: properties.map((property) => ({
      id: property.id,
      name: property.name,
      producerName: property.producer_name || '',
      plots: plots
        .filter((plot) => plot.property_id === property.id)
        .map((plot) => ({ id: plot.id, name: plot.name, area: nullable(plot.area) })),
    })),
    products,
    producers,
    buyers,
  };
}
