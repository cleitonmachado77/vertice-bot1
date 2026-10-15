import { one, run } from './db.js';
import { getActiveCompanyId } from './forms-companies.js';
import { odooCreate, odooSearchRead, odooWrite } from './odoo-client.js';
import type { EntityPartner } from './forms-entities.js';

function text(value: unknown): string {
  if (value === false || value == null) return '';
  return String(value).trim();
}

export async function pushPartnerToOdoo(id: string): Promise<EntityPartner> {
  const companyId = getActiveCompanyId();
  const row = await one<{
    id: string;
    name: string;
    is_customer: number;
    is_vendor: number;
    odoo_id: string;
    email: string;
    phone: string;
    vat: string;
    street: string;
    city: string;
    is_company: number;
    updated_at: string;
  }>(
    `SELECT id, name, is_customer, is_vendor, COALESCE(odoo_id, '') AS odoo_id,
            COALESCE(email, '') AS email, COALESCE(phone, '') AS phone,
            COALESCE(vat, '') AS vat, COALESCE(street, '') AS street,
            COALESCE(city, '') AS city, COALESCE(is_company, 0) AS is_company,
            updated_at
     FROM forms_partners
     WHERE id = $1 AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`,
    [id, companyId],
  );
  if (!row) throw new Error('Parceiro não encontrado');
  const name = text(row.name);
  if (!name) throw new Error('Nome obrigatório');

  const values: Record<string, unknown> = {
    name,
    email: text(row.email) || false,
    phone: text(row.phone) || false,
    vat: text(row.vat) || false,
    street: text(row.street) || false,
    city: text(row.city) || false,
    is_company: Number(row.is_company) === 1,
    customer_rank: Number(row.is_customer) === 1 ? 1 : 0,
    supplier_rank: Number(row.is_vendor) === 1 ? 1 : 0,
    company_id: Number(companyId) || false,
  };

  let odooId = Number(row.odoo_id || 0);
  if (odooId > 0) {
    await odooWrite('res.partner', [odooId], values);
  } else {
    const found = await odooSearchRead<{ id: number }>(
      'res.partner',
      [['name', '=', name]],
      ['id'],
      { limit: 1 },
    );
    if (found[0]?.id) {
      odooId = found[0].id;
      await odooWrite('res.partner', [odooId], values);
    } else {
      odooId = await odooCreate('res.partner', values);
    }
  }

  await run(
    `UPDATE forms_partners SET odoo_id = $2, updated_at = NOW() WHERE id = $1`,
    [id, String(odooId)],
  );

  return {
    id: row.id,
    name: row.name,
    is_customer: Number(row.is_customer) === 1,
    is_vendor: Number(row.is_vendor) === 1,
    odoo_id: String(odooId),
    email: text(row.email),
    phone: text(row.phone),
    vat: text(row.vat),
    street: text(row.street),
    city: text(row.city),
    is_company: Number(row.is_company) === 1,
    updated_at: new Date().toISOString(),
  };
}
