import { run } from './db.js';
import { ensureAgroSchema } from './agro-schema.js';

/** Alinha nomes e ids do Agro com o espelho local do Odoo (parceiros, produtos e pedidos). */

export async function refreshAgroMirror(companyId: string): Promise<void> {
  await ensureAgroSchema();
  await run(
    `UPDATE agro_properties pr
     SET producer_partner_id = match.id, updated_at = NOW()
     FROM (
       SELECT DISTINCT ON (lower(name)) id, name
       FROM forms_partners
       WHERE is_vendor = 1 AND (company_odoo_id = $1 OR company_odoo_id = '0')
       ORDER BY lower(name), CASE WHEN company_odoo_id = $1 THEN 0 ELSE 1 END, updated_at DESC
     ) match
     WHERE pr.company_odoo_id = $1
       AND pr.producer_partner_id = ''
       AND pr.producer_name <> ''
       AND lower(match.name) = lower(pr.producer_name)`,
    [companyId],
  );
  await run(
    `UPDATE agro_properties pr
     SET producer_name = fp.name,
         odoo_partner_id = CASE
           WHEN COALESCE(fp.odoo_id, '') <> '' THEN fp.odoo_id
           ELSE pr.odoo_partner_id
         END,
         updated_at = NOW()
     FROM forms_partners fp
     WHERE pr.producer_partner_id = fp.id
       AND pr.company_odoo_id = $1
       AND (
         pr.producer_name IS DISTINCT FROM fp.name
         OR (COALESCE(fp.odoo_id, '') <> '' AND pr.odoo_partner_id IS DISTINCT FROM fp.odoo_id)
       )`,
    [companyId],
  );
  await run(
    `UPDATE agro_deliveries e
     SET partner_name = fp.name, updated_at = NOW()
     FROM forms_partners fp, agro_plantings p
     WHERE e.partner_id = fp.id
       AND p.id = e.planting_id
       AND p.company_odoo_id = $1
       AND e.partner_name IS DISTINCT FROM fp.name`,
    [companyId],
  );
  await syncProductNames(companyId);
  await syncSaleDocuments(companyId);
}

async function syncProductNames(companyId: string): Promise<void> {
  try {
    await run(
      `UPDATE agro_plantings p
       SET product_name = sub.name,
           unit = CASE WHEN sub.uom <> '' THEN sub.uom ELSE p.unit END,
           updated_at = NOW()
       FROM (
         SELECT id,
           COALESCE(header_json::json->>'name', '') AS name,
           COALESCE(header_json::json->>'uom', '') AS uom
         FROM forms_documents
         WHERE kind = 'product' AND header_json ~ '^\\s*\\{'
       ) sub
       WHERE p.product_id = sub.id
         AND p.company_odoo_id = $1
         AND sub.name <> ''
         AND (p.product_name IS DISTINCT FROM sub.name OR (sub.uom <> '' AND p.unit IS DISTINCT FROM sub.uom))`,
      [companyId],
    );
  } catch (error) {
    console.warn('agro: nome do produto no espelho ignorado', error instanceof Error ? error.message : error);
  }
}

async function syncSaleDocuments(companyId: string): Promise<void> {
  try {
    await run(
      `UPDATE agro_deliveries e
       SET document = sub.ref, updated_at = NOW()
       FROM (
         SELECT id, COALESCE(header_json::json->>'order_reference', '') AS ref
         FROM forms_documents
         WHERE kind = 'sale' AND header_json ~ '^\\s*\\{'
       ) sub, agro_plantings p
       WHERE e.sale_document_id = sub.id
         AND p.id = e.planting_id
         AND p.company_odoo_id = $1
         AND sub.ref <> ''
         AND e.document IS DISTINCT FROM sub.ref`,
      [companyId],
    );
  } catch (error) {
    console.warn('agro: pedido de venda no espelho ignorado', error instanceof Error ? error.message : error);
  }
}
