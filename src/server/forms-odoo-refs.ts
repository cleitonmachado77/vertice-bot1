import { many, run } from './db.js';
import { odooSearchRead } from './odoo-client.js';
import { odooLabelPt } from './odoo-pt.js';

function m2oId(value: unknown): string {
  if (Array.isArray(value) && value[0] != null) return String(value[0]);
  if (typeof value === 'number' && value > 0) return String(value);
  return '';
}

export type OdooRefType =
  | 'category'
  | 'uom'
  | 'payment_term'
  | 'tax'
  | 'sales_team'
  | 'tag';

export type OdooRefItem = {
  id: string;
  ref_type: OdooRefType;
  odoo_id: string;
  name: string;
  meta: Record<string, string>;
};

function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function ensureOdooRefsTable(): Promise<void> {
  await run(`
    CREATE TABLE IF NOT EXISTS forms_odoo_refs (
      id TEXT PRIMARY KEY,
      ref_type TEXT NOT NULL,
      odoo_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      name_key TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_forms_odoo_refs_type_odoo
     ON forms_odoo_refs(ref_type, odoo_id)`,
  );
  await run(`CREATE INDEX IF NOT EXISTS idx_forms_odoo_refs_type_name ON forms_odoo_refs(ref_type, name_key)`);
}

async function upsertRefs(
  refType: OdooRefType,
  rows: Array<{ odoo_id: string; name: string; meta?: Record<string, string> }>,
): Promise<number> {
  await ensureOdooRefsTable();
  const clean = rows
    .map((row) => ({
      id: `${refType}:${row.odoo_id}`,
      odoo_id: String(row.odoo_id || ''),
      name: String(row.name || '').trim(),
      name_key: nameKey(String(row.name || '')),
      meta_json: JSON.stringify(row.meta || {}),
    }))
    .filter((row) => row.name && row.odoo_id);

  if (!clean.length) return 0;

  const chunkSize = 200;
  for (let offset = 0; offset < clean.length; offset += chunkSize) {
    const chunk = clean.slice(offset, offset + chunkSize);
    const params: unknown[] = [];
    const placeholders = chunk.map((row, index) => {
      const base = index * 6;
      params.push(row.id, refType, row.odoo_id, row.name, row.name_key, row.meta_json);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, NOW())`;
    });
    await run(
      `INSERT INTO forms_odoo_refs(id, ref_type, odoo_id, name, name_key, meta_json, updated_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (ref_type, odoo_id) DO UPDATE SET
         name = EXCLUDED.name,
         name_key = EXCLUDED.name_key,
         meta_json = EXCLUDED.meta_json,
         updated_at = NOW()`,
      params,
    );
  }
  return clean.length;
}

function parseMeta(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value || {})) {
      out[key] = item == null ? '' : String(item);
    }
    return out;
  } catch {
    return {};
  }
}

export async function listOdooRefs(refType?: OdooRefType): Promise<OdooRefItem[]> {
  await ensureOdooRefsTable();
  const rows = refType
    ? await many<{
        id: string;
        ref_type: string;
        odoo_id: string;
        name: string;
        meta_json: string;
      }>(
        `SELECT id, ref_type, odoo_id, name, meta_json FROM forms_odoo_refs
         WHERE ref_type = $1 ORDER BY name ASC`,
        [refType],
      )
    : await many<{
        id: string;
        ref_type: string;
        odoo_id: string;
        name: string;
        meta_json: string;
      }>(
        `SELECT id, ref_type, odoo_id, name, meta_json FROM forms_odoo_refs ORDER BY ref_type, name ASC`,
      );

  return rows.map((row) => ({
    id: row.id,
    ref_type: row.ref_type as OdooRefType,
    odoo_id: row.odoo_id,
    name: row.name,
    meta: parseMeta(row.meta_json),
  }));
}

export async function listOdooRefsGrouped(): Promise<Record<OdooRefType, OdooRefItem[]>> {
  const all = await listOdooRefs();
  const grouped: Record<OdooRefType, OdooRefItem[]> = {
    category: [],
    uom: [],
    payment_term: [],
    tax: [],
    sales_team: [],
    tag: [],
  };
  for (const item of all) {
    if (grouped[item.ref_type]) grouped[item.ref_type].push(item);
  }
  return grouped;
}

/** Baixa cadastros auxiliares do Odoo usados nos seletores dos Forms. */
export async function pullOdooRefs(): Promise<Record<OdooRefType, number>> {
  await ensureOdooRefsTable();
  const counts: Record<OdooRefType, number> = {
    category: 0,
    uom: 0,
    payment_term: 0,
    tax: 0,
    sales_team: 0,
    tag: 0,
  };

  // Não ordenar por complete_name: em vários Odoo ele não é stored e o search_read falha
  // ("Cannot convert product.category.complete_name to SQL"). Falha era engolida → 0 categorias.
  type CategoryRow = { id: number; name: string; complete_name?: string; parent_id?: unknown };
  const categories: CategoryRow[] =
    (await odooSearchRead<CategoryRow>(
      'product.category',
      [],
      ['id', 'name', 'complete_name', 'parent_id'],
      { limit: 5000, order: 'name asc' },
    ).catch(() => null)) ||
    (await odooSearchRead<CategoryRow>('product.category', [], ['id', 'name'], {
      limit: 5000,
      order: 'name asc',
    }).catch((error) => {
      console.warn(
        'odoo-refs: product.category falhou:',
        error instanceof Error ? error.message : error,
      );
      return [] as CategoryRow[];
    }));
  counts.category = await upsertRefs(
    'category',
    categories.map((row) => ({
      odoo_id: String(row.id),
      name: odooLabelPt(String(row.complete_name || row.name || '')),
      meta: { short_name: odooLabelPt(String(row.name || '')) },
    })),
  );

  // Odoo 19: unidade relativa a outra (“Bag” contém 100 “KG”). `factor` = quantidade absoluta
  // na unidade raiz da árvore — mesma conversão que o Odoo faz entre unidades.
  type UomRow = { id: number; name: string; factor?: number; relative_factor?: number; relative_uom_id?: unknown };
  const uoms: UomRow[] =
    (await odooSearchRead<UomRow>(
      'uom.uom',
      [['active', '=', true]],
      ['id', 'name', 'factor', 'relative_factor', 'relative_uom_id'],
      { limit: 2000, order: 'name asc' },
    ).catch(() => null)) ||
    (await odooSearchRead<UomRow>('uom.uom', [], ['id', 'name'], { limit: 2000, order: 'name asc' }).catch(() => []));
  const byId = new Map(uoms.map((row) => [row.id, row]));
  /** Unidade raiz da árvore e quantas unidades raiz cabem em 1 desta (Bag → KG, 100). */
  const absolute = (id: number): { rootId: number; factor: number } => {
    let current = id;
    let factor = 1;
    for (let depth = 0; depth < 20; depth += 1) {
      const row = byId.get(current);
      const parent = Number(m2oId(row?.relative_uom_id)) || 0;
      if (!row || !parent || parent === current) break;
      factor *= Number(row.relative_factor) || 1;
      current = parent;
    }
    return { rootId: current, factor };
  };
  counts.uom = await upsertRefs(
    'uom',
    uoms.map((row) => {
      const tree = absolute(row.id);
      return {
        odoo_id: String(row.id),
        name: odooLabelPt(String(row.name || '')),
        meta: {
          root_id: String(tree.rootId),
          factor: String(tree.factor),
          relative_uom_id: m2oId(row.relative_uom_id),
        },
      };
    }),
  );

  const terms = await odooSearchRead<{ id: number; name: string }>(
    'account.payment.term',
    [],
    ['id', 'name'],
    { limit: 1000, order: 'name asc' },
  ).catch(() => []);
  counts.payment_term = await upsertRefs(
    'payment_term',
    terms.map((row) => ({
      odoo_id: String(row.id),
      name: String(row.name || ''),
    })),
  );

  const taxFieldsFull = ['id', 'name', 'type_tax_use', 'amount', 'company_id', 'country_id'];
  const taxFieldsCore = ['id', 'name', 'type_tax_use', 'amount', 'company_id'];
  const taxes =
    (await odooSearchRead<{
      id: number;
      name: string;
      type_tax_use?: string;
      amount?: number;
      company_id?: unknown;
      country_id?: unknown;
    }>('account.tax', [['active', '=', true]], taxFieldsFull, {
      limit: 2000,
      order: 'name asc',
    }).catch(() => null)) ||
    (await odooSearchRead<{
      id: number;
      name: string;
      type_tax_use?: string;
      amount?: number;
      company_id?: unknown;
      country_id?: unknown;
    }>('account.tax', [['active', '=', true]], taxFieldsCore, {
      limit: 2000,
      order: 'name asc',
    }).catch(() => []));
  counts.tax = await upsertRefs(
    'tax',
    taxes.map((row) => ({
      odoo_id: String(row.id),
      name: String(row.name || ''),
      meta: {
        type_tax_use: String(row.type_tax_use || ''),
        amount: row.amount != null ? String(row.amount) : '',
        company_id: m2oId(row.company_id),
        country_id: m2oId(row.country_id),
      },
    })),
  );

  const teams = await odooSearchRead<{ id: number; name: string }>(
    'crm.team',
    [],
    ['id', 'name'],
    { limit: 500, order: 'name asc' },
  ).catch(() => []);
  counts.sales_team = await upsertRefs(
    'sales_team',
    teams.map((row) => ({
      odoo_id: String(row.id),
      name: String(row.name || ''),
    })),
  );

  const tags = await odooSearchRead<{ id: number; name: string }>(
    'crm.tag',
    [],
    ['id', 'name'],
    { limit: 1000, order: 'name asc' },
  ).catch(() => []);
  counts.tag = await upsertRefs(
    'tag',
    tags.map((row) => ({
      odoo_id: String(row.id),
      name: String(row.name || ''),
    })),
  );

  return counts;
}
