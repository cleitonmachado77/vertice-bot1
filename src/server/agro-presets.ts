import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { parseFormsBotRules, sanitizeFormsBotRules, type FormsBotRules } from './forms-bot-rules.js';
import {
  agroBotFields,
  isAgroBotKind,
  type AgroBotKind,
} from './agro-bot-fields.js';

/** Padrão do Agro: mesmos campos de Bot que os formulários (contato, template, regras). */

export type AgroPreset = {
  id: string;
  company_odoo_id: string;
  kind: AgroBotKind;
  name: string;
  header: Record<string, string>;
  visible: string[];
  bot_enabled: boolean;
  bot_frequency: 'daily' | 'weekdays' | 'weekly';
  bot_weekday: number;
  bot_send_time: string;
  bot_template_id: string;
  bot_contact_id: string;
  bot_rules: FormsBotRules;
};

export type AgroPresetInput = Partial<Omit<AgroPreset, 'id' | 'company_odoo_id' | 'kind' | 'bot_rules'>> & {
  kind?: string;
  bot_rules?: unknown;
};

type PresetRow = {
  id: string;
  company_odoo_id: string;
  kind: string;
  name: string;
  header_json: string;
  visible_json: string;
  bot_enabled: number;
  bot_frequency: string;
  bot_weekday: number;
  bot_send_time: string;
  bot_template_id: string;
  bot_contact_id: string;
  bot_rules_json: string;
};

let ready: Promise<void> | null = null;

export function ensureAgroPresets(): Promise<void> {
  if (!ready) {
    ready = createTable().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

async function createTable(): Promise<void> {
  await run(`
    CREATE TABLE IF NOT EXISTS agro_presets (
      id TEXT PRIMARY KEY,
      company_odoo_id TEXT NOT NULL DEFAULT '1',
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      header_json TEXT NOT NULL DEFAULT '{}',
      visible_json TEXT NOT NULL DEFAULT '[]',
      bot_enabled INTEGER NOT NULL DEFAULT 0,
      bot_frequency TEXT NOT NULL DEFAULT 'daily',
      bot_weekday INTEGER NOT NULL DEFAULT 1,
      bot_send_time TEXT NOT NULL DEFAULT '08:00',
      bot_template_id TEXT NOT NULL DEFAULT '',
      bot_contact_id TEXT NOT NULL DEFAULT '',
      bot_rules_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_presets_company_kind_name
     ON agro_presets(company_odoo_id, kind, lower(name))`,
  );
}

function sendTime(raw: unknown): string {
  const value = String(raw || '08:00').trim();
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) return '08:00';
  const [hour, minute] = value.split(':');
  return `${hour.padStart(2, '0')}:${minute}`;
}

function frequency(raw: unknown): AgroPreset['bot_frequency'] {
  const value = String(raw || 'daily');
  return value === 'weekdays' || value === 'weekly' ? value : 'daily';
}

function headerOf(kind: AgroBotKind, raw: unknown): Record<string, string> {
  const allowed = new Set(agroBotFields(kind).map((field) => field.key));
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(src)) {
    if (!allowed.has(key)) continue;
    out[key] = String(value ?? '').trim().slice(0, 200);
  }
  return out;
}

function visibleOf(kind: AgroBotKind, raw: unknown): string[] {
  const allowed = agroBotFields(kind).map((field) => field.key);
  if (!Array.isArray(raw)) return allowed;
  const picked = raw.map((item) => String(item)).filter((key) => allowed.includes(key));
  return picked.length ? picked : allowed;
}

function mapRow(row: PresetRow): AgroPreset {
  const kind: AgroBotKind = isAgroBotKind(row.kind) ? row.kind : 'agro_plantio';
  let header: Record<string, string> = {};
  let visible: unknown = [];
  try {
    header = JSON.parse(row.header_json || '{}') as Record<string, string>;
  } catch {
    header = {};
  }
  try {
    visible = JSON.parse(row.visible_json || '[]');
  } catch {
    visible = [];
  }
  return {
    id: row.id,
    company_odoo_id: row.company_odoo_id,
    kind,
    name: row.name,
    header: headerOf(kind, header),
    visible: visibleOf(kind, visible),
    bot_enabled: Number(row.bot_enabled) === 1,
    bot_frequency: frequency(row.bot_frequency),
    bot_weekday: Math.min(6, Math.max(0, Number(row.bot_weekday) || 1)),
    bot_send_time: sendTime(row.bot_send_time),
    bot_template_id: row.bot_template_id || '',
    bot_contact_id: row.bot_contact_id || '',
    bot_rules: parseFormsBotRules(row.bot_rules_json),
  };
}

const SELECT = `SELECT id, company_odoo_id, kind, name, header_json, visible_json, bot_enabled,
  bot_frequency, bot_weekday, bot_send_time, bot_template_id, bot_contact_id, bot_rules_json
  FROM agro_presets`;

export async function listAgroPresets(companyId: string, kind: string): Promise<AgroPreset[]> {
  await ensureAgroPresets();
  if (!isAgroBotKind(kind)) throw new Error('Tipo inválido');
  const rows = await many<PresetRow>(
    `${SELECT} WHERE company_odoo_id = $1 AND kind = $2 ORDER BY name ASC`,
    [companyId, kind],
  );
  return rows.map(mapRow);
}

export async function getAgroPreset(companyId: string, id: string): Promise<AgroPreset | null> {
  await ensureAgroPresets();
  const row = await one<PresetRow>(`${SELECT} WHERE id = $1 AND company_odoo_id = $2`, [id, companyId]);
  return row ? mapRow(row) : null;
}

export async function getAgroPresetById(id: string): Promise<AgroPreset | null> {
  await ensureAgroPresets();
  const row = await one<PresetRow>(`${SELECT} WHERE id = $1`, [id]);
  return row ? mapRow(row) : null;
}

function valuesFrom(kind: AgroBotKind, input: AgroPresetInput) {
  return {
    name: String(input.name || '').trim().slice(0, 60),
    header: headerOf(kind, input.header),
    visible: visibleOf(kind, input.visible),
    botEnabled: Boolean(input.bot_enabled),
    botFrequency: frequency(input.bot_frequency),
    botWeekday: Math.min(6, Math.max(0, Number(input.bot_weekday) || 1)),
    botSendTime: sendTime(input.bot_send_time),
    botTemplateId: String(input.bot_template_id || '').trim().slice(0, 120),
    botContactId: String(input.bot_contact_id || '').trim().slice(0, 120),
    botRules: sanitizeFormsBotRules(input.bot_rules),
  };
}

export async function saveAgroPreset(companyId: string, input: AgroPresetInput, id = ''): Promise<AgroPreset> {
  await ensureAgroPresets();
  const kind = String(input.kind || '');
  if (!isAgroBotKind(kind)) throw new Error('Tipo inválido');
  const current = id ? await getAgroPreset(companyId, id) : null;
  if (id && !current) throw new Error('Padrão não encontrado');
  const values = valuesFrom(current?.kind || kind, { ...input, kind: current?.kind || kind });
  if (!values.name) throw new Error('Nome do padrão obrigatório');
  if (values.botEnabled && !values.botContactId) throw new Error('Escolha o contato que recebe no WhatsApp');
  const presetId = current?.id || randomUUID();
  const duplicate = await one<{ id: string }>(
    `SELECT id FROM agro_presets
     WHERE company_odoo_id = $1 AND kind = $2 AND lower(name) = lower($3) AND id <> $4`,
    [companyId, current?.kind || kind, values.name, presetId],
  );
  if (duplicate) throw new Error(`Já existe um padrão chamado "${values.name}" nesta empresa`);
  if (!current) {
    await run(
      `INSERT INTO agro_presets(
         id, company_odoo_id, kind, name, header_json, visible_json, bot_enabled, bot_frequency,
         bot_weekday, bot_send_time, bot_template_id, bot_contact_id, bot_rules_json
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        presetId, companyId, kind, values.name, JSON.stringify(values.header), JSON.stringify(values.visible),
        values.botEnabled ? 1 : 0, values.botFrequency, values.botWeekday, values.botSendTime,
        values.botTemplateId, values.botContactId, JSON.stringify(values.botRules),
      ],
    );
  } else {
    await run(
      `UPDATE agro_presets SET
         name = $2, header_json = $3, visible_json = $4, bot_enabled = $5, bot_frequency = $6,
         bot_weekday = $7, bot_send_time = $8, bot_template_id = $9, bot_contact_id = $10,
         bot_rules_json = $11, updated_at = NOW()
       WHERE id = $1`,
      [
        presetId, values.name, JSON.stringify(values.header), JSON.stringify(values.visible),
        values.botEnabled ? 1 : 0, values.botFrequency, values.botWeekday, values.botSendTime,
        values.botTemplateId, values.botContactId, JSON.stringify(values.botRules),
      ],
    );
  }
  const saved = await getAgroPreset(companyId, presetId);
  if (!saved) throw new Error('Não foi possível salvar o padrão');
  return saved;
}

export async function deleteAgroPreset(companyId: string, id: string): Promise<void> {
  await ensureAgroPresets();
  const current = await getAgroPreset(companyId, id);
  if (!current) throw new Error('Padrão não encontrado');
  await run(`DELETE FROM agro_presets WHERE id = $1 AND company_odoo_id = $2`, [id, companyId]);
}
