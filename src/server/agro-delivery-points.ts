import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { upsertPartner } from './forms-catalog.js';
import { clip } from './agro-resolve.js';
import { ensureAgroSchema } from './agro-schema.js';

export type AgroDeliveryPoint = {
  id: string;
  name: string;
  partnerId: string;
  sortOrder: number;
};

const DEFAULT_POINTS = ['Sacolão', 'Escola Municipal', 'Escola Estadual', 'Coara'];

async function linkPartner(companyId: string, name: string): Promise<string> {
  const partner = await upsertPartner(name, 'customer', companyId);
  return partner?.id || '';
}

/** Garante os 4 locais padrão na primeira vez (por empresa). */
export async function ensureDefaultDeliveryPoints(companyId: string): Promise<void> {
  await ensureAgroSchema();
  const existing = await one<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM agro_delivery_points
     WHERE company_odoo_id = $1 AND active = 1`,
    [companyId],
  );
  if ((existing?.total || 0) > 0) return;
  for (let index = 0; index < DEFAULT_POINTS.length; index += 1) {
    const name = DEFAULT_POINTS[index];
    const partnerId = await linkPartner(companyId, name);
    await run(
      `INSERT INTO agro_delivery_points(
         id, company_odoo_id, name, partner_id, sort_order, active, created_at, updated_at
       ) VALUES($1, $2, $3, $4, $5, 1, NOW(), NOW())`,
      [randomUUID(), companyId, name, partnerId, index + 1],
    );
  }
}

export async function listDeliveryPoints(companyId: string): Promise<AgroDeliveryPoint[]> {
  await ensureDefaultDeliveryPoints(companyId);
  const rows = await many<{
    id: string;
    name: string;
    partner_id: string;
    sort_order: number;
  }>(
    `SELECT id, name, COALESCE(partner_id, '') AS partner_id, sort_order
     FROM agro_delivery_points
     WHERE company_odoo_id = $1 AND active = 1
     ORDER BY sort_order ASC, lower(name) ASC`,
    [companyId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    partnerId: row.partner_id || '',
    sortOrder: Number(row.sort_order) || 0,
  }));
}

/** Catálogo de entrega/Bot: id = partner do Odoo. */
export async function listDeliveryPointBuyers(
  companyId: string,
): Promise<Array<{ id: string; name: string }>> {
  const points = await listDeliveryPoints(companyId);
  const buyers: Array<{ id: string; name: string }> = [];
  for (const point of points) {
    let partnerId = point.partnerId;
    if (!partnerId) {
      partnerId = await linkPartner(companyId, point.name);
      if (partnerId) {
        await run(
          `UPDATE agro_delivery_points SET partner_id = $2, updated_at = NOW() WHERE id = $1`,
          [point.id, partnerId],
        );
      }
    }
    if (!partnerId) continue;
    buyers.push({ id: partnerId, name: point.name });
  }
  return buyers;
}

export async function saveDeliveryPoint(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroDeliveryPoint> {
  await ensureAgroSchema();
  const name = clip(input.name, 150);
  if (!name) throw new Error('Informe o nome do local de entrega');
  const sortOrderRaw = Number(input.sortOrder ?? input.sort_order ?? 0);
  const sortOrder = Number.isFinite(sortOrderRaw) ? Math.max(0, Math.trunc(sortOrderRaw)) : 0;

  const current = id
    ? await one<{ id: string }>(
        `SELECT id FROM agro_delivery_points
         WHERE id = $1 AND company_odoo_id = $2 AND active = 1`,
        [id, companyId],
      )
    : undefined;
  if (id && !current) throw new Error('Local de entrega não encontrado');

  const clash = await one<{ id: string }>(
    `SELECT id FROM agro_delivery_points
     WHERE company_odoo_id = $1 AND lower(name) = lower($2) AND active = 1 AND id <> $3`,
    [companyId, name, current?.id || ''],
  );
  if (clash) throw new Error('Já existe um local de entrega com este nome');

  const partnerId = await linkPartner(companyId, name);
  const pointId = current?.id || randomUUID();
  if (!current) {
    const last = await one<{ sort_order: number }>(
      `SELECT COALESCE(MAX(sort_order), 0)::int AS sort_order
       FROM agro_delivery_points WHERE company_odoo_id = $1 AND active = 1`,
      [companyId],
    );
    const order = sortOrder > 0 ? sortOrder : Number(last?.sort_order || 0) + 1;
    await run(
      `INSERT INTO agro_delivery_points(
         id, company_odoo_id, name, partner_id, sort_order, active, created_at, updated_at
       ) VALUES($1, $2, $3, $4, $5, 1, NOW(), NOW())`,
      [pointId, companyId, name, partnerId, order],
    );
    return { id: pointId, name, partnerId, sortOrder: order };
  }

  await run(
    `UPDATE agro_delivery_points
     SET name = $1, partner_id = $2, sort_order = CASE WHEN $3 > 0 THEN $3 ELSE sort_order END,
         updated_at = NOW()
     WHERE id = $4 AND company_odoo_id = $5`,
    [name, partnerId, sortOrder, pointId, companyId],
  );
  const saved = (await listDeliveryPoints(companyId)).find((item) => item.id === pointId);
  if (!saved) throw new Error('Não foi possível salvar o local de entrega');
  return saved;
}

export async function deleteDeliveryPoint(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const updated = await one<{ id: string }>(
    `UPDATE agro_delivery_points SET active = 0, updated_at = NOW()
     WHERE id = $1 AND company_odoo_id = $2 AND active = 1
     RETURNING id`,
    [id, companyId],
  );
  if (!updated) throw new Error('Local de entrega não encontrado');
}
