import { one, run } from './db.js';
import { plotLabel } from './agro-resolve.js';
import { odooConfigured, odooCreate, odooSearchRead, odooWrite } from './odoo-client.js';

/** Propriedade e talhão viram locais internos do depósito da empresa. O produtor vira contato. */

export function assertOdooReady(): void {
  if (!odooConfigured()) {
    throw new Error('Configure o Odoo em Configurações antes de registrar no Vertice Agro');
  }
}

function many2oneId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (typeof value === 'number' && value > 0) return value;
  return 0;
}

function companyContext(companyId: number): Record<string, unknown> {
  return { allowed_company_ids: [companyId], force_company: companyId };
}

async function warehouseStockLocation(companyId: number): Promise<number> {
  const [warehouse] = await odooSearchRead<{ lot_stock_id: unknown }>(
    'stock.warehouse',
    [['company_id', '=', companyId]],
    ['lot_stock_id'],
    { limit: 1 },
  );
  const locationId = many2oneId(warehouse?.lot_stock_id);
  if (!locationId) throw new Error(`Empresa Odoo ${companyId} sem depósito interno`);
  return locationId;
}

async function ensureInternalLocation(companyId: number, parentId: number, name: string): Promise<number> {
  const found = await odooSearchRead<{ id: number }>(
    'stock.location',
    [
      '&',
      '&',
      '&',
      ['name', '=', name],
      ['location_id', '=', parentId],
      ['usage', '=', 'internal'],
      '|',
      ['company_id', '=', companyId],
      ['company_id', '=', false],
    ],
    ['id'],
    { limit: 1 },
  );
  if (found[0]?.id) return found[0].id;
  return odooCreate(
    'stock.location',
    { name, location_id: parentId, usage: 'internal', company_id: companyId },
    { context: companyContext(companyId) },
  );
}

async function keepLocation(companyId: number, parentId: number, name: string, stored: string): Promise<number> {
  const current = Number(stored || 0);
  if (current > 0) {
    const ok = await odooWrite('stock.location', [current], { name }).catch(() => false);
    if (ok) return current;
  }
  return ensureInternalLocation(companyId, parentId, name);
}

async function supplierRank(partnerId: number): Promise<number> {
  const [partner] = await odooSearchRead<{ supplier_rank: number }>(
    'res.partner',
    [['id', '=', partnerId]],
    ['supplier_rank'],
    { limit: 1 },
  );
  return Number(partner?.supplier_rank || 0);
}

/** O produtor entra no Odoo como fornecedor, sem regravar os outros campos do contato. */
async function ensureProducer(companyId: number, partnerLocalId: string, stored: string): Promise<string> {
  if (!partnerLocalId) return stored || '';
  const row = await one<{ name: string; odoo_id: string }>(
    `SELECT name, COALESCE(odoo_id, '') AS odoo_id FROM forms_partners WHERE id = $1`,
    [partnerLocalId],
  );
  if (!row) return stored || '';
  let odooId = Number(row.odoo_id || stored || 0);
  if (odooId > 0) {
    if ((await supplierRank(odooId)) < 1) {
      await odooWrite('res.partner', [odooId], { supplier_rank: 1 });
    }
    if (!row.odoo_id) {
      await run(`UPDATE forms_partners SET odoo_id = $2, updated_at = NOW() WHERE id = $1`, [
        partnerLocalId,
        String(odooId),
      ]);
    }
  } else {
    const found = await odooSearchRead<{ id: number }>(
      'res.partner',
      ['&', ['name', '=', row.name.trim()], '|', ['company_id', '=', companyId], ['company_id', '=', false]],
      ['id'],
      { limit: 1 },
    );
    odooId =
      found[0]?.id ||
      (await odooCreate(
        'res.partner',
        { name: row.name.trim(), company_id: companyId, supplier_rank: 1 },
        { context: companyContext(companyId) },
      ));
    if (found[0]?.id && (await supplierRank(odooId)) < 1) {
      await odooWrite('res.partner', [odooId], { supplier_rank: 1 });
    }
    await run(`UPDATE forms_partners SET odoo_id = $2, updated_at = NOW() WHERE id = $1`, [
      partnerLocalId,
      String(odooId),
    ]);
  }
  return String(odooId);
}

export async function syncAgroPlace(
  companyId: string,
  propertyId: string,
  plotId: string,
): Promise<{ plotLocationId: number }> {
  assertOdooReady();
  const company = Number(companyId);
  if (!company) throw new Error('Empresa do Odoo inválida');
  const property = await one<{
    name: string;
    producer_partner_id: string;
    odoo_location_id: string;
    odoo_partner_id: string;
  }>(
    `SELECT name, COALESCE(producer_partner_id, '') AS producer_partner_id,
            COALESCE(odoo_location_id, '') AS odoo_location_id,
            COALESCE(odoo_partner_id, '') AS odoo_partner_id
     FROM agro_properties WHERE id = $1 AND company_odoo_id = $2`,
    [propertyId, companyId],
  );
  const plot = await one<{ code: string; name: string; odoo_location_id: string }>(
    `SELECT COALESCE(code, '') AS code, name, COALESCE(odoo_location_id, '') AS odoo_location_id
     FROM agro_plots WHERE id = $1 AND property_id = $2`,
    [plotId, propertyId],
  );
  if (!property || !plot) throw new Error('Propriedade ou talhão não encontrado');

  const stock = await warehouseStockLocation(company);
  const propertyLocation = await keepLocation(company, stock, property.name, property.odoo_location_id);
  const partnerId = await ensureProducer(company, property.producer_partner_id, property.odoo_partner_id);
  await run(
    `UPDATE agro_properties
     SET odoo_location_id = $2, odoo_partner_id = $3, updated_at = NOW()
     WHERE id = $1`,
    [propertyId, String(propertyLocation), partnerId],
  );
  const plotLocation = await keepLocation(
    company,
    propertyLocation,
    plotLabel(plot.code, plot.name),
    plot.odoo_location_id,
  );
  await run(`UPDATE agro_plots SET odoo_location_id = $2, updated_at = NOW() WHERE id = $1`, [
    plotId,
    String(plotLocation),
  ]);
  return { plotLocationId: plotLocation };
}
