import { randomBytes, randomUUID } from 'node:crypto';
import { many, one, run, withTransaction } from './db.js';
import { getActiveCompanyId } from './forms-companies.js';
import {
  documentTitle,
  emptyHeader,
  emptyLine,
  isFormKind,
  normalizeFormStatus,
  type FormKind,
} from './forms-fields.js';
import { syncSharedCatalog } from './forms-catalog.js';

export type FormDocument = {
  id: string;
  kind: FormKind;
  title: string;
  status: string;
  header: Record<string, string>;
  lines: Array<{ id: string; sort_order: number; values: Record<string, string> }>;
  public_token: string | null;
  public_enabled: boolean;
  company_odoo_id: string;
  created_at: string;
  updated_at: string;
};

type DocRow = {
  id: string;
  kind: string;
  title: string;
  status: string;
  header_json: string;
  public_token: string | null;
  public_enabled: number;
  company_odoo_id?: string;
  created_at: string;
  updated_at: string;
};

type LineRow = {
  id: string;
  document_id: string;
  sort_order: number;
  line_json: string;
};

function parseJson(raw: string): Record<string, string> {
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

function mapDoc(row: DocRow, lines: LineRow[] = []): FormDocument {
  return {
    id: row.id,
    kind: row.kind as FormKind,
    title: row.title,
    status: row.status,
    header: parseJson(row.header_json),
    lines: lines
      .filter((line) => line.document_id === row.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((line) => ({
        id: line.id,
        sort_order: line.sort_order,
        values: parseJson(line.line_json),
      })),
    public_token: row.public_token,
    public_enabled: Number(row.public_enabled) === 1,
    company_odoo_id: row.company_odoo_id || getActiveCompanyId(),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listFormDocuments(
  kind: FormKind,
  options: { includeLines?: boolean } = {},
): Promise<FormDocument[]> {
  const companyId = getActiveCompanyId();
  const rows = await many<DocRow>(
    `SELECT * FROM forms_documents
     WHERE kind = $1 AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2
     ORDER BY updated_at DESC`,
    [kind, companyId],
  );
  if (!rows.length) return [];
  if (options.includeLines === false) {
    return rows.map((row) => mapDoc(row, []));
  }
  const ids = rows.map((row) => row.id);
  const lines = await many<LineRow>(
    `SELECT * FROM forms_document_lines
     WHERE document_id = ANY($1::text[])
     ORDER BY sort_order ASC`,
    [ids],
  );
  return rows.map((row) => mapDoc(row, lines));
}

export async function getFormDocument(id: string): Promise<FormDocument | undefined> {
  const row = await one<DocRow>(`SELECT * FROM forms_documents WHERE id = $1`, [id]);
  if (!row) return undefined;
  const lines = await many<LineRow>(
    `SELECT * FROM forms_document_lines WHERE document_id = $1 ORDER BY sort_order ASC`,
    [id],
  );
  return mapDoc(row, lines);
}

export async function getFormByPublicToken(token: string): Promise<FormDocument | undefined> {
  const row = await one<DocRow>(
    `SELECT * FROM forms_documents WHERE public_token = $1 AND public_enabled = 1`,
    [token],
  );
  if (!row) return undefined;
  const lines = await many<LineRow>(
    `SELECT * FROM forms_document_lines WHERE document_id = $1 ORDER BY sort_order ASC`,
    [row.id],
  );
  return mapDoc(row, lines);
}

export async function createFormDocument(kind: FormKind): Promise<FormDocument> {
  if (!isFormKind(kind)) throw new Error('Tipo de formulário inválido');
  const id = randomUUID();
  const header = emptyHeader(kind);
  const title = documentTitle(kind, header);
  const now = new Date().toISOString();
  const companyId = getActiveCompanyId();
  await run(
    `INSERT INTO forms_documents(id, kind, title, status, header_json, company_odoo_id, created_at, updated_at)
     VALUES($1, $2, $3, 'draft', $4, $5, $6, $6)`,
    [id, kind, title, JSON.stringify(header), companyId, now],
  );
  if (kind !== 'product') {
    const lineId = randomUUID();
    await run(
      `INSERT INTO forms_document_lines(id, document_id, sort_order, line_json, created_at, updated_at)
       VALUES($1, $2, 0, $3, $4, $4)`,
      [lineId, id, JSON.stringify(emptyLine(kind)), now],
    );
  }
  const created = await getFormDocument(id);
  if (!created) throw new Error('Não foi possível criar o formulário');
  return created;
}

export type FormSaveInput = {
  title?: string;
  status?: string;
  header?: Record<string, string>;
  lines?: Array<{ id?: string; values: Record<string, string> }>;
};

export async function saveFormDocument(id: string, input: FormSaveInput): Promise<FormDocument> {
  const current = await getFormDocument(id);
  if (!current) throw new Error('Formulário não encontrado');

  const header = { ...current.header, ...(input.header || {}) };
  // Número do pedido vem da sequência do Odoo — não sobrescrever com vazio
  if (
    (current.kind === 'sale' || current.kind === 'purchase') &&
    current.header.order_reference &&
    !String(header.order_reference || '').trim()
  ) {
    header.order_reference = current.header.order_reference;
  }
  const title = (input.title || documentTitle(current.kind, header)).trim() || current.title;
  const status = normalizeFormStatus(current.kind, input.status || current.status || 'draft');
  if (current.kind === 'sale' || current.kind === 'purchase') {
    header.odoo_state = status;
  }
  const now = new Date().toISOString();

  await withTransaction(async () => {
    await run(
      `UPDATE forms_documents
       SET title = $2, status = $3, header_json = $4, updated_at = $5
       WHERE id = $1`,
      [id, title, status, JSON.stringify(header), now],
    );

    if (current.kind !== 'product' && Array.isArray(input.lines)) {
      await run(`DELETE FROM forms_document_lines WHERE document_id = $1`, [id]);
      let order = 0;
      for (const line of input.lines) {
        const values = line.values || emptyLine(current.kind);
        await run(
          `INSERT INTO forms_document_lines(id, document_id, sort_order, line_json, created_at, updated_at)
           VALUES($1, $2, $3, $4, $5, $5)`,
          [line.id || randomUUID(), id, order, JSON.stringify(values), now],
        );
        order += 1;
      }
    }
  });

  const saved = await getFormDocument(id);
  if (!saved) throw new Error('Formulário não encontrado após salvar');
  await syncSharedCatalog(saved);
  return saved;
}

export async function deleteFormDocument(id: string): Promise<void> {
  await run(`DELETE FROM forms_document_lines WHERE document_id = $1`, [id]);
  await run(`DELETE FROM forms_documents WHERE id = $1`, [id]);
}

export async function enablePublicLink(id: string): Promise<FormDocument> {
  const current = await getFormDocument(id);
  if (!current) throw new Error('Formulário não encontrado');
  const token = current.public_token || randomBytes(18).toString('hex');
  await run(
    `UPDATE forms_documents
     SET public_token = $2, public_enabled = 1, updated_at = NOW()
     WHERE id = $1`,
    [id, token],
  );
  const updated = await getFormDocument(id);
  if (!updated) throw new Error('Formulário não encontrado');
  return updated;
}

export async function disablePublicLink(id: string): Promise<FormDocument> {
  await run(
    `UPDATE forms_documents SET public_enabled = 0, updated_at = NOW() WHERE id = $1`,
    [id],
  );
  const updated = await getFormDocument(id);
  if (!updated) throw new Error('Formulário não encontrado');
  return updated;
}

export async function savePublicForm(token: string, input: FormSaveInput): Promise<FormDocument> {
  const current = await getFormByPublicToken(token);
  if (!current) throw new Error('Link inválido ou desativado');
  return saveFormDocument(current.id, input);
}
