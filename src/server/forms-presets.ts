import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { getActiveCompanyId } from './forms-companies.js';
import {
  headerFieldsFor,
  isFormKind,
  lineFieldsFor,
  normalizeFormStatus,
  type FormKind,
} from './forms-fields.js';

export type FormPresetVisible = {
  title: boolean;
  status: boolean;
  header: string[];
  lines: string[];
};

export type FormPreset = {
  id: string;
  company_odoo_id: string;
  kind: FormKind;
  name: string;
  /** Título aplicado ao criar um novo registro a partir do padrão. */
  title: string;
  status: string;
  header: Record<string, string>;
  lines: Array<{ values: Record<string, string> }>;
  visible: FormPresetVisible;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type FormPresetInput = {
  kind?: string;
  name?: string;
  title?: string;
  status?: string;
  header?: Record<string, string>;
  lines?: Array<{ values?: Record<string, string> }>;
  visible?: Partial<FormPresetVisible> | null;
  sort_order?: number;
};

type PresetRow = {
  id: string;
  company_odoo_id: string;
  kind: string;
  name: string;
  title?: string;
  status: string;
  header_json: string;
  lines_json: string;
  visible_json?: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function allHeaderKeys(kind: FormKind): string[] {
  return headerFieldsFor(kind).map((field) => field.key);
}

function editableHeaderKeys(kind: FormKind): Set<string> {
  return new Set(
    headerFieldsFor(kind)
      .filter((field) => !field.readonly)
      .map((field) => field.key),
  );
}

function defaultVisible(kind: FormKind): FormPresetVisible {
  return {
    title: true,
    status: kind !== 'product',
    // Readonly (ex.: número do pedido) começa desmarcado — não aparece no novo.
    header: headerFieldsFor(kind)
      .filter((field) => !field.readonly)
      .map((field) => field.key),
    lines: lineFieldsFor(kind).map((field) => field.key),
  };
}

function parseHeader(raw: string, kind: FormKind): Record<string, string> {
  const allowed = editableHeaderKeys(kind);
  const out: Record<string, string> = {};
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    for (const [key, item] of Object.entries(value || {})) {
      if (!allowed.has(key)) continue;
      // Mantém string vazia — limpar um campo no editor precisa sobreviver ao reload.
      out[key] = item == null ? '' : String(item);
    }
  } catch {
    /* keep empty */
  }
  return out;
}

function parseLines(raw: string, kind: FormKind): Array<{ values: Record<string, string> }> {
  const lineKeys = new Set(lineFieldsFor(kind).map((field) => field.key));
  if (!lineKeys.size) return [];
  try {
    const value = JSON.parse(raw || '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
      const values: Record<string, string> = {};
      const src =
        item && typeof item === 'object'
          ? ((item as { values?: Record<string, unknown> }).values ||
              (item as Record<string, unknown>))
          : {};
      for (const [key, cell] of Object.entries(src || {})) {
        if (!lineKeys.has(key)) continue;
        values[key] = cell == null ? '' : String(cell);
      }
      return { values };
    });
  } catch {
    return [];
  }
}

function sanitizeVisible(kind: FormKind, input?: Partial<FormPresetVisible> | null): FormPresetVisible {
  const fallback = defaultVisible(kind);
  if (!input || typeof input !== 'object') return fallback;
  const headerAllowed = new Set(allHeaderKeys(kind));
  const lineAllowed = new Set(lineFieldsFor(kind).map((field) => field.key));
  const header = Array.isArray(input.header)
    ? input.header.map(String).filter((key) => headerAllowed.has(key))
    : fallback.header;
  const lines = Array.isArray(input.lines)
    ? input.lines.map(String).filter((key) => lineAllowed.has(key))
    : fallback.lines;
  return {
    title: input.title == null ? fallback.title : Boolean(input.title),
    status: kind === 'product' ? false : input.status == null ? fallback.status : Boolean(input.status),
    header,
    lines,
  };
}

function parseVisible(raw: string | undefined, kind: FormKind): FormPresetVisible {
  try {
    const value = JSON.parse(raw || '{}') as Partial<FormPresetVisible>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultVisible(kind);
    if (
      value.title == null &&
      value.status == null &&
      !Array.isArray(value.header) &&
      !Array.isArray(value.lines)
    ) {
      return defaultVisible(kind);
    }
    return sanitizeVisible(kind, value);
  } catch {
    return defaultVisible(kind);
  }
}

function mapPreset(row: PresetRow): FormPreset {
  const kind = row.kind as FormKind;
  return {
    id: row.id,
    company_odoo_id: row.company_odoo_id || getActiveCompanyId(),
    kind,
    name: row.name,
    title: String(row.title || '').trim(),
    status: normalizeFormStatus(kind, row.status || 'draft'),
    header: parseHeader(row.header_json, kind),
    lines: parseLines(row.lines_json, kind),
    visible: parseVisible(row.visible_json, kind),
    sort_order: Number(row.sort_order) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sanitizeHeader(kind: FormKind, input?: Record<string, string>): Record<string, string> {
  const allowed = editableHeaderKeys(kind);
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const key of allowed) {
    if (!(key in input)) continue;
    // Persiste vazio para o clear no UI não “voltar” no próximo open.
    out[key] = String(input[key] ?? '');
  }
  return out;
}

function sanitizeLines(
  kind: FormKind,
  input?: Array<{ values?: Record<string, string> }>,
): Array<{ values: Record<string, string> }> {
  const allowed = new Set(lineFieldsFor(kind).map((field) => field.key));
  if (!allowed.size) return [];
  if (!Array.isArray(input)) return [];
  return input.map((line) => {
    const values: Record<string, string> = {};
    const src = line?.values || {};
    for (const key of allowed) {
      if (!(key in src)) continue;
      values[key] = String(src[key] ?? '');
    }
    return { values };
  });
}

async function assertUniqueName(
  companyId: string,
  kind: FormKind,
  name: string,
  excludeId?: string,
): Promise<void> {
  const row = await one<{ id: string }>(
    `SELECT id FROM forms_presets
     WHERE company_odoo_id = $1 AND kind = $2 AND lower(name) = lower($3)
       ${excludeId ? 'AND id <> $4' : ''}
     LIMIT 1`,
    excludeId ? [companyId, kind, name, excludeId] : [companyId, kind, name],
  );
  if (row) throw new Error(`Já existe um padrão chamado "${name}" nesta empresa`);
}

export async function listFormPresets(kind: FormKind): Promise<FormPreset[]> {
  if (!isFormKind(kind)) throw new Error('Tipo inválido');
  const companyId = getActiveCompanyId();
  const rows = await many<PresetRow>(
    `SELECT * FROM forms_presets
     WHERE company_odoo_id = $1 AND kind = $2
     ORDER BY sort_order ASC, name ASC`,
    [companyId, kind],
  );
  return rows.map(mapPreset);
}

export async function getFormPreset(id: string): Promise<FormPreset | null> {
  const companyId = getActiveCompanyId();
  const row = await one<PresetRow>(
    `SELECT * FROM forms_presets WHERE id = $1 AND company_odoo_id = $2`,
    [id, companyId],
  );
  return row ? mapPreset(row) : null;
}

export async function createFormPreset(input: FormPresetInput): Promise<FormPreset> {
  const kind = String(input.kind || '');
  if (!isFormKind(kind)) throw new Error('Tipo inválido');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Nome do padrão obrigatório');
  const companyId = getActiveCompanyId();
  await assertUniqueName(companyId, kind, name);

  const title = String(input.title || '').trim().slice(0, 200);
  const status = normalizeFormStatus(kind, String(input.status || 'draft'));
  const header = sanitizeHeader(kind, input.header);
  const lines = sanitizeLines(kind, input.lines);
  const visible = sanitizeVisible(kind, input.visible);
  const sortOrder =
    Number.isFinite(Number(input.sort_order)) && input.sort_order != null
      ? Number(input.sort_order)
      : (
          await one<{ n: number }>(
            `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM forms_presets
             WHERE company_odoo_id = $1 AND kind = $2`,
            [companyId, kind],
          )
        )?.n ?? 0;

  const id = randomUUID();
  await run(
    `INSERT INTO forms_presets
      (id, company_odoo_id, kind, name, title, status, header_json, lines_json, visible_json, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      companyId,
      kind,
      name,
      title,
      status,
      JSON.stringify(header),
      JSON.stringify(lines),
      JSON.stringify(visible),
      sortOrder,
    ],
  );
  const created = await getFormPreset(id);
  if (!created) throw new Error('Falha ao criar padrão');
  return created;
}

export async function updateFormPreset(id: string, input: FormPresetInput): Promise<FormPreset> {
  const current = await getFormPreset(id);
  if (!current) throw new Error('Padrão não encontrado');

  const name = input.name != null ? String(input.name).trim() : current.name;
  if (!name) throw new Error('Nome do padrão obrigatório');
  await assertUniqueName(current.company_odoo_id, current.kind, name, id);

  const title =
    input.title != null ? String(input.title || '').trim().slice(0, 200) : current.title;
  const status =
    input.status != null
      ? normalizeFormStatus(current.kind, String(input.status || 'draft'))
      : current.status;
  const header =
    input.header != null ? sanitizeHeader(current.kind, input.header) : current.header;
  const lines = input.lines != null ? sanitizeLines(current.kind, input.lines) : current.lines;
  const visible =
    input.visible != null ? sanitizeVisible(current.kind, input.visible) : current.visible;
  const sortOrder =
    input.sort_order != null && Number.isFinite(Number(input.sort_order))
      ? Number(input.sort_order)
      : current.sort_order;

  await run(
    `UPDATE forms_presets
     SET name = $2, title = $3, status = $4, header_json = $5, lines_json = $6, visible_json = $7,
         sort_order = $8, updated_at = NOW()
     WHERE id = $1 AND company_odoo_id = $9`,
    [
      id,
      name,
      title,
      status,
      JSON.stringify(header),
      JSON.stringify(lines),
      JSON.stringify(visible),
      sortOrder,
      current.company_odoo_id,
    ],
  );
  const updated = await getFormPreset(id);
  if (!updated) throw new Error('Padrão não encontrado');
  return updated;
}

export async function deleteFormPreset(id: string): Promise<void> {
  const current = await getFormPreset(id);
  if (!current) throw new Error('Padrão não encontrado');
  await run(`DELETE FROM forms_presets WHERE id = $1 AND company_odoo_id = $2`, [
    id,
    current.company_odoo_id,
  ]);
}
