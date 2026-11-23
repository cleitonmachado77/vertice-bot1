import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { clip } from './agro-resolve.js';
import { parseIsoDate, parseMoney, parseQuantity } from './agro-rules.js';
import { ensureAgroSchema } from './agro-schema.js';
import { PLOT_LABEL_SQL } from './agro-model.js';

export type AgroCost = {
  id: string;
  plotId: string;
  plotName: string;
  propertyId: string;
  propertyName: string;
  costOn: string;
  name: string;
  quantity: number;
  unitPrice: number | null;
  totalValue: number | null;
  notes: string;
};

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullable(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function listCosts(companyId: string): Promise<AgroCost[]> {
  await ensureAgroSchema();
  const rows = await many<{
    id: string;
    plot_id: string;
    plot_name: string;
    property_id: string;
    property_name: string;
    cost_on: string;
    name: string;
    quantity: number;
    unit_price: number | null;
    notes: string;
  }>(
    `SELECT c.id, c.plot_id, ${PLOT_LABEL_SQL} AS plot_name, pr.id AS property_id, pr.name AS property_name,
            to_char(c.cost_on, 'YYYY-MM-DD') AS cost_on, c.name, c.quantity, c.unit_price, c.notes
     FROM agro_costs c
     JOIN agro_plots pl ON pl.id = c.plot_id
     JOIN agro_properties pr ON pr.id = pl.property_id
     WHERE c.company_odoo_id = $1 AND c.active = 1 AND pl.active = 1 AND pr.active = 1
     ORDER BY c.cost_on DESC, c.created_at DESC`,
    [companyId],
  );
  return rows.map((row) => {
    const unitPrice = nullable(row.unit_price);
    const quantity = num(row.quantity);
    return {
      id: row.id,
      plotId: row.plot_id,
      plotName: row.plot_name || '',
      propertyId: row.property_id,
      propertyName: row.property_name || '',
      costOn: row.cost_on,
      name: row.name,
      quantity,
      unitPrice,
      totalValue: unitPrice == null ? null : Math.round(quantity * unitPrice * 100) / 100,
      notes: row.notes || '',
    };
  });
}

export async function getCost(companyId: string, id: string): Promise<AgroCost | undefined> {
  return (await listCosts(companyId)).find((item) => item.id === id);
}

export async function saveCost(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroCost> {
  await ensureAgroSchema();
  const plotId = clip(input.plotId, 80);
  if (!plotId) throw new Error('Informe a área (talhão)');
  const plot = await one<{ id: string }>(
    `SELECT pl.id
     FROM agro_plots pl
     JOIN agro_properties pr ON pr.id = pl.property_id
     WHERE pl.id = $1 AND pr.company_odoo_id = $2 AND pl.active = 1 AND pr.active = 1`,
    [plotId, companyId],
  );
  if (!plot) throw new Error('Talhão não encontrado nesta empresa');

  const name = clip(input.name, 150);
  if (!name) throw new Error('Informe o nome do custo');
  const costOn = parseIsoDate(input.costOn);
  const quantity = parseQuantity(input.quantity, 'Quantidade');
  const unitPrice = parseMoney(input.unitPrice);
  const notes = clip(input.notes, 500);

  const current = id
    ? await one<{ id: string }>(
        `SELECT id FROM agro_costs WHERE id = $1 AND company_odoo_id = $2 AND active = 1`,
        [id, companyId],
      )
    : undefined;
  if (id && !current) throw new Error('Custo não encontrado');

  const costId = current?.id || randomUUID();
  if (!current) {
    await run(
      `INSERT INTO agro_costs(
         id, company_odoo_id, plot_id, cost_on, name, quantity, unit_price, notes, active, created_at, updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,NOW(),NOW())`,
      [costId, companyId, plotId, costOn, name, quantity, unitPrice, notes],
    );
  } else {
    await run(
      `UPDATE agro_costs SET
         plot_id = $1, cost_on = $2, name = $3, quantity = $4, unit_price = $5, notes = $6, updated_at = NOW()
       WHERE id = $7 AND company_odoo_id = $8`,
      [plotId, costOn, name, quantity, unitPrice, notes, costId, companyId],
    );
  }

  const saved = await getCost(companyId, costId);
  if (!saved) throw new Error('Não foi possível salvar o custo');
  return saved;
}

export async function deleteCost(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const updated = await one<{ id: string }>(
    `UPDATE agro_costs SET active = 0, updated_at = NOW()
     WHERE id = $1 AND company_odoo_id = $2 AND active = 1
     RETURNING id`,
    [id, companyId],
  );
  if (!updated) throw new Error('Custo não encontrado');
}
