import { randomUUID } from 'node:crypto';
import { one, run } from './db.js';
import { parseQuantity } from './agro-rules.js';
import { upsertPartner } from './forms-catalog.js';

export function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function resolveProperty(companyId: string, input: Record<string, unknown>): Promise<string> {
  const propertyId = clip(input.propertyId, 80);
  if (propertyId && propertyId !== '__new__') {
    const row = await one<{ id: string }>(
      `SELECT id FROM agro_properties WHERE id = $1 AND company_odoo_id = $2 AND active = 1`,
      [propertyId, companyId],
    );
    if (!row) throw new Error('Propriedade não encontrada');
    return row.id;
  }
  const name = clip(input.propertyName, 150);
  if (!name) throw new Error('Informe a propriedade');
  const existing = await one<{ id: string }>(
    `SELECT id FROM agro_properties WHERE company_odoo_id = $1 AND lower(name) = lower($2)`,
    [companyId, name],
  );
  if (existing) return existing.id;
  const id = randomUUID();
  const stamp = nowIso();
  await run(
    `INSERT INTO agro_properties(id, company_odoo_id, name, producer_name, active, created_at, updated_at)
     VALUES($1, $2, $3, $4, 1, $5, $5)`,
    [id, companyId, name, clip(input.producerName, 150), stamp],
  );
  return id;
}

/** Produtor do plantio é o fornecedor do espelho do Odoo. */
export async function resolveProducer(
  companyId: string,
  input: Record<string, unknown>,
): Promise<{ id: string; name: string; producerId?: string }> {
  const farmProducerId = clip(input.producerId, 80);
  if (farmProducerId) {
    const farm = await one<{ id: string; name: string; partner_id: string }>(
      `SELECT id, name, COALESCE(partner_id, '') AS partner_id
       FROM agro_producers WHERE id = $1 AND company_odoo_id = $2 AND active = 1`,
      [farmProducerId, companyId],
    );
    if (!farm) throw new Error('Produtor não encontrado em Configurações');
    let partnerId = farm.partner_id;
    if (!partnerId) {
      const created = await upsertPartner(farm.name, 'vendor', companyId);
      partnerId = created?.id || '';
      if (partnerId) {
        await run(`UPDATE agro_producers SET partner_id = $2, updated_at = NOW() WHERE id = $1`, [
          farm.id,
          partnerId,
        ]);
      }
    }
    return { id: partnerId, name: farm.name, producerId: farm.id };
  }
  const partnerId = clip(input.producerPartnerId, 80);
  if (partnerId && partnerId !== '__custom__') {
    const row = await one<{ id: string; name: string }>(
      `SELECT id, name FROM forms_partners
       WHERE id = $1 AND is_vendor = 1 AND (company_odoo_id = $2 OR company_odoo_id = '0')`,
      [partnerId, companyId],
    );
    if (!row) throw new Error('Fornecedor não encontrado');
    return { id: row.id, name: row.name };
  }
  const name = clip(input.producerName, 150);
  if (!name) return { id: '', name: '' };
  const created = await upsertPartner(name, 'vendor', companyId);
  if (!created) return { id: '', name: '' };
  return { id: created.id, name: created.name };
}

export async function assignProducer(
  companyId: string,
  propertyId: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (!('producerPartnerId' in input) && !('producerName' in input) && !('producerId' in input)) return;
  const producer = await resolveProducer(companyId, input);
  if (!producer.id && !producer.producerId) return;
  await run(
    `UPDATE agro_properties
     SET producer_partner_id = $2, producer_name = $3,
         producer_id = CASE WHEN $5 <> '' THEN $5 ELSE producer_id END,
         updated_at = NOW()
     WHERE id = $1 AND company_odoo_id = $4`,
    [propertyId, producer.id, producer.name, companyId, producer.producerId || ''],
  );
}

export async function resolvePlot(propertyId: string, input: Record<string, unknown>): Promise<string> {
  const plotId = clip(input.plotId, 80);
  if (plotId && plotId !== '__new__') {
    const row = await one<{ id: string }>(
      `SELECT id FROM agro_plots WHERE id = $1 AND property_id = $2 AND active = 1`,
      [plotId, propertyId],
    );
    if (!row) throw new Error('Talhão não encontrado nesta propriedade');
    return row.id;
  }
  const name = clip(input.plotName, 150);
  if (!name) throw new Error('Informe o talhão');
  const existing = await one<{ id: string }>(
    `SELECT id FROM agro_plots WHERE property_id = $1 AND lower(name) = lower($2)`,
    [propertyId, name],
  );
  if (existing) return existing.id;
  const area =
    String(input.plotArea ?? '').trim() === '' ? null : parseQuantity(input.plotArea, 'Área do talhão');
  const id = randomUUID();
  const stamp = nowIso();
  await run(
    `INSERT INTO agro_plots(id, property_id, name, area, active, created_at, updated_at)
     VALUES($1, $2, $3, $4, 1, $5, $5)`,
    [id, propertyId, name, area, stamp],
  );
  return id;
}

export async function resolveProduct(
  companyId: string,
  input: Record<string, unknown>,
): Promise<{ id: string; name: string; unit: string }> {
  const productId = clip(input.productId, 80);
  if (productId && productId !== '__custom__') {
    const row = await one<{ id: string; header_json: string }>(
      `SELECT id, header_json FROM forms_documents
       WHERE id = $1 AND kind = 'product' AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`,
      [productId, companyId],
    );
    if (!row) throw new Error('Produto não encontrado no inventário desta empresa');
    let name = '';
    let unit = '';
    try {
      const header = JSON.parse(row.header_json || '{}') as Record<string, unknown>;
      name = String(header.name || '').trim();
      unit = String(header.uom || '').trim();
    } catch {
      name = '';
    }
    if (!name) throw new Error('Produto sem nome no inventário');
    return { id: row.id, name, unit: clip(unit || input.unit, 20) || 'un' };
  }
  const name = clip(input.productName, 150);
  const unit = clip(input.unit, 20);
  if (!name) throw new Error('Informe o produto');
  if (!unit) throw new Error('Informe a unidade do produto');
  return { id: '', name, unit };
}

export async function resolveBuyer(
  companyId: string,
  input: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const partnerId = clip(input.partnerId, 80);
  if (partnerId && partnerId !== '__custom__') {
    const row = await one<{ id: string; name: string }>(
      `SELECT id, name FROM forms_partners
       WHERE id = $1 AND is_customer = 1 AND (company_odoo_id = $2 OR company_odoo_id = '0')`,
      [partnerId, companyId],
    );
    if (!row) throw new Error('Comprador não encontrado');
    return { id: row.id, name: row.name };
  }
  const name = clip(input.partnerName, 150);
  if (!name) throw new Error('Informe o comprador');
  return { id: '', name };
}
