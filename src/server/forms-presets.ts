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
  /** Quando true, o Vertice Bot dispara perguntas deste padrão via WhatsApp. */
  bot_enabled: boolean;
  bot_frequency: 'daily' | 'weekdays' | 'weekly';
  bot_weekday: number;
  bot_send_time: string;
  /** Template Meta usado quando a janela de 24h do WhatsApp está fechada. */
  bot_template_id: string;
  /** Contato WhatsApp que recebe o questionário deste padrão. */
  bot_contact_id: string;
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
  bot_enabled?: boolean;
  bot_frequency?: string;
  bot_weekday?: number;
  bot_send_time?: string;
  bot_template_id?: string;
  bot_contact_id?: string;
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
  bot_enabled?: number;
  bot_frequency?: string;
  bot_weekday?: number;
  bot_send_time?: string;
  bot_template_id?: string;
  bot_contact_id?: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const BOT_FREQUENCIES = new Set(['daily', 'weekdays', 'weekly']);

function sanitizeBotFrequency(raw: unknown): 'daily' | 'weekdays' | 'weekly' {
  const value = String(raw || 'daily').trim();
  return BOT_FREQUENCIES.has(value) ? (value as 'daily' | 'weekdays' | 'weekly') : 'daily';
}

function sanitizeBotWeekday(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 6) return 1;
  return Math.trunc(value);
}

function sanitizeBotSendTime(raw: unknown): string {
  const value = String(raw || '08:00').trim();
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) return '08:00';
  const [h, m] = value.split(':');
  return `${String(h).padStart(2, '0')}:${m}`;
}

function sanitizeBotTemplateId(raw: unknown): string {
  return String(raw || '').trim().slice(0, 120);
}

function sanitizeBotContactId(raw: unknown): string {
  return String(raw || '').trim().slice(0, 120);
}

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
    bot_enabled: Number(row.bot_enabled) === 1,
    bot_frequency: sanitizeBotFrequency(row.bot_frequency),
    bot_weekday: sanitizeBotWeekday(row.bot_weekday),
    bot_send_time: sanitizeBotSendTime(row.bot_send_time),
    bot_template_id: sanitizeBotTemplateId(row.bot_template_id),
    bot_contact_id: sanitizeBotContactId(row.bot_contact_id),
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

/** Busca padrão sem filtrar pela empresa ativa (uso interno do Bot). */
export async function getFormPresetById(id: string): Promise<FormPreset | null> {
  const row = await one<PresetRow>(`SELECT * FROM forms_presets WHERE id = $1`, [id]);
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
  const botEnabled = Boolean(input.bot_enabled);
  const botFrequency = sanitizeBotFrequency(input.bot_frequency);
  const botWeekday = sanitizeBotWeekday(input.bot_weekday);
  const botSendTime = sanitizeBotSendTime(input.bot_send_time);
  const botTemplateId = sanitizeBotTemplateId(input.bot_template_id);
  const botContactId = sanitizeBotContactId(input.bot_contact_id);
  if (botEnabled) {
    if (!botContactId) {
      throw new Error('Para o Bot: selecione ou cadastre o contato que receberá o WhatsApp');
    }
    const { buildFormsBotQuestions } = await import('./forms-bot.js');
    const draft: FormPreset = {
      id: '',
      company_odoo_id: companyId,
      kind,
      name,
      title,
      status,
      header,
      lines,
      visible,
      bot_enabled: true,
      bot_frequency: botFrequency,
      bot_weekday: botWeekday,
      bot_send_time: botSendTime,
      bot_template_id: botTemplateId,
      bot_contact_id: botContactId,
      sort_order: 0,
      created_at: '',
      updated_at: '',
    };
    const built = buildFormsBotQuestions(draft);
    if (!built.questions.length) {
      throw new Error(
        'Para o Bot: marque “Mostrar” em campos sem valor padrão (são as perguntas do WhatsApp)',
      );
    }
  }
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
      (id, company_odoo_id, kind, name, title, status, header_json, lines_json, visible_json,
       bot_enabled, bot_frequency, bot_weekday, bot_send_time, bot_template_id, bot_contact_id, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
      botEnabled ? 1 : 0,
      botFrequency,
      botWeekday,
      botSendTime,
      botTemplateId,
      botContactId,
      sortOrder,
    ],
  );
  const created = await getFormPreset(id);
  if (!created) throw new Error('Falha ao criar padrão');
  if (created.bot_enabled) {
    const { syncFormsBotQuestionnaire } = await import('./forms-bot.js');
    await syncFormsBotQuestionnaire(created);
  }
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
  const botEnabled =
    input.bot_enabled != null ? Boolean(input.bot_enabled) : current.bot_enabled;
  const botFrequency =
    input.bot_frequency != null
      ? sanitizeBotFrequency(input.bot_frequency)
      : current.bot_frequency;
  const botWeekday =
    input.bot_weekday != null ? sanitizeBotWeekday(input.bot_weekday) : current.bot_weekday;
  const botSendTime =
    input.bot_send_time != null
      ? sanitizeBotSendTime(input.bot_send_time)
      : current.bot_send_time;
  const botTemplateId =
    input.bot_template_id != null
      ? sanitizeBotTemplateId(input.bot_template_id)
      : current.bot_template_id;
  const botContactId =
    input.bot_contact_id != null
      ? sanitizeBotContactId(input.bot_contact_id)
      : current.bot_contact_id;
  if (botEnabled && !botContactId) {
    throw new Error('Para o Bot: selecione ou cadastre o contato que receberá o WhatsApp');
  }
  const sortOrder =
    input.sort_order != null && Number.isFinite(Number(input.sort_order))
      ? Number(input.sort_order)
      : current.sort_order;

  await run(
    `UPDATE forms_presets
     SET name = $2, title = $3, status = $4, header_json = $5, lines_json = $6, visible_json = $7,
         bot_enabled = $8, bot_frequency = $9, bot_weekday = $10, bot_send_time = $11,
         bot_template_id = $12, bot_contact_id = $13, sort_order = $14, updated_at = NOW()
     WHERE id = $1 AND company_odoo_id = $15`,
    [
      id,
      name,
      title,
      status,
      JSON.stringify(header),
      JSON.stringify(lines),
      JSON.stringify(visible),
      botEnabled ? 1 : 0,
      botFrequency,
      botWeekday,
      botSendTime,
      botTemplateId,
      botContactId,
      sortOrder,
      current.company_odoo_id,
    ],
  );
  const updated = await getFormPreset(id);
  if (!updated) throw new Error('Padrão não encontrado');
  const { syncFormsBotQuestionnaire } = await import('./forms-bot.js');
  await syncFormsBotQuestionnaire(updated);
  return updated;
}

export async function deleteFormPreset(id: string): Promise<void> {
  const current = await getFormPreset(id);
  if (!current) throw new Error('Padrão não encontrado');
  const { syncFormsBotQuestionnaire } = await import('./forms-bot.js');
  await syncFormsBotQuestionnaire({ ...current, bot_enabled: false });
  await run(`DELETE FROM forms_presets WHERE id = $1 AND company_odoo_id = $2`, [
    id,
    current.company_odoo_id,
  ]);
}
