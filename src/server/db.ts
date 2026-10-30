import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { databaseConnectionString } from './database-url.js';
import { env } from './env.js';
import { partnerNameKey } from './forms-name-key.js';

const cache = new Map<string, string>();
const transactionStorage = new AsyncLocalStorage<pg.PoolClient>();
let pool: pg.Pool | undefined;

export async function many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await query(sql, params);
  return result.rows as T[];
}

export async function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await many<T>(sql, params);
  return rows[0];
}

export async function run(sql: string, params: unknown[] = []): Promise<void> {
  await query(sql, params);
}

export async function withTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (transactionStorage.getStore()) return work();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const value = await transactionStorage.run(client, work);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function query(sql: string, params: unknown[]): Promise<pg.QueryResult> {
  const client = transactionStorage.getStore();
  return client ? client.query(sql, params) : getPool().query(sql, params);
}

/** Impede dois workers (web + cron Railway) de dispararem ao mesmo tempo. */
export async function withDispatchLock<T>(
  work: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false; value?: undefined }> {
  const client = await getPool().connect();
  try {
    const locked = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      DISPATCH_LOCK_KEY,
    ]);
    if (!locked.rows[0]?.locked) return { ran: false };
    try {
      return { ran: true, value: await work() };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [DISPATCH_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

const DISPATCH_LOCK_KEY = 87421013;

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export function getSetting(key: string, fallback = ''): string {
  return cache.get(key) ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    `INSERT INTO settings(key, value) VALUES($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
  cache.set(key, value);
}

export async function initDatabase(): Promise<void> {
  await getPool().query(SCHEMA);
  await migrate();
  await importLocalSqlite();
  await seedSettings();
  const rows = await many<{ key: string; value: string }>('SELECT key, value FROM settings');
  cache.clear();
  for (const row of rows) cache.set(row.key, row.value);
  const { ensureBootstrapAdmin } = await import('./users.js');
  await ensureBootstrapAdmin();
}

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = databaseConnectionString(env('DATABASE_URL'));
  if (!connectionString) throw new Error('DATABASE_URL não configurada');
  pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 12000,
    idleTimeoutMillis: 30_000,
  });
  // Evita derrubar o processo em ECONNRESET idle do Postgres.
  pool.on('error', (error) => {
    console.error('pg pool:', error instanceof Error ? error.message : error);
  });
  return pool;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    bot_enabled INTEGER NOT NULL DEFAULT 1,
    blocked INTEGER NOT NULL DEFAULT 0,
    tags_json TEXT NOT NULL DEFAULT '[]',
    roteiro_id TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    contact_phone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    last_message_at TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    media_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    raw_json TEXT NOT NULL DEFAULT '{}',
    origin TEXT NOT NULL DEFAULT 'contact'
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS roteiros (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    daily_message TEXT NOT NULL DEFAULT '',
    send_time TEXT NOT NULL DEFAULT '09:00',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dispatches (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    roteiro_id TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    sent_at TEXT NOT NULL DEFAULT '',
    response_type TEXT NOT NULL DEFAULT '',
    response_text TEXT NOT NULL DEFAULT '',
    response_media_url TEXT NOT NULL DEFAULT '',
    response_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    frequency TEXT NOT NULL DEFAULT 'daily',
    weekday INTEGER NOT NULL DEFAULT 1,
    send_time TEXT NOT NULL DEFAULT '09:00',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS questionnaires (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    greeting TEXT NOT NULL DEFAULT '',
    frequency TEXT NOT NULL DEFAULT 'daily',
    weekday INTEGER NOT NULL DEFAULT 1,
    send_time TEXT NOT NULL DEFAULT '09:00',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS questionnaire_questions (
    id TEXT PRIMARY KEY,
    questionnaire_id TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    expected_type TEXT NOT NULL DEFAULT 'any',
    export_field TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS questionnaire_assignments (
    questionnaire_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (questionnaire_id, contact_id)
  );
  CREATE TABLE IF NOT EXISTS questionnaire_cycles (
    id TEXT PRIMARY KEY,
    questionnaire_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    occurrence_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    template_sent_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    superseded_at TEXT NOT NULL DEFAULT '',
    pending_question_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS questionnaire_answers (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    answer_text TEXT NOT NULL DEFAULT '',
    answer_type TEXT NOT NULL DEFAULT 'text',
    media_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS questionnaire_revisions (
    id TEXT PRIMARY KEY,
    questionnaire_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    greeting TEXT NOT NULL DEFAULT '',
    frequency TEXT NOT NULL,
    weekday INTEGER NOT NULL,
    send_time TEXT NOT NULL,
    template_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(questionnaire_id, version)
  );
  CREATE TABLE IF NOT EXISTS questionnaire_revision_questions (
    revision_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    body TEXT NOT NULL,
    expected_type TEXT NOT NULL,
    export_field TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL,
    PRIMARY KEY(revision_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_questionnaire_context (
    conversation_id TEXT PRIMARY KEY,
    active_cycle_id TEXT NOT NULL DEFAULT '',
    candidate_cycle_ids_json TEXT NOT NULL DEFAULT '[]',
    awaiting_selection INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_menu_state (
    conversation_id TEXT PRIMARY KEY,
    node_json TEXT NOT NULL DEFAULT '{}',
    shown_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inbound_jobs (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS outbound_outbox (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    phone TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    template_id TEXT NOT NULL DEFAULT '',
    variables_json TEXT NOT NULL DEFAULT '[]',
    channel_id TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    contact_id TEXT NOT NULL DEFAULT '',
    cycle_id TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'agent',
    raw_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    error TEXT NOT NULL DEFAULT '',
    response_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS forms_documents (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    header_json TEXT NOT NULL DEFAULT '{}',
    public_token TEXT UNIQUE,
    public_enabled INTEGER NOT NULL DEFAULT 0,
    company_odoo_id TEXT NOT NULL DEFAULT '1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS forms_document_lines (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    line_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS forms_partners (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    name_key TEXT NOT NULL DEFAULT '',
    is_customer INTEGER NOT NULL DEFAULT 0,
    is_vendor INTEGER NOT NULL DEFAULT 0,
    odoo_id TEXT NOT NULL DEFAULT '',
    company_odoo_id TEXT NOT NULL DEFAULT '1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS forms_companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    vat TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '',
    partner_odoo_id TEXT NOT NULL DEFAULT '',
    country_odoo_id TEXT NOT NULL DEFAULT '',
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS panel_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    company_odoo_id TEXT NOT NULL DEFAULT '',
    whatsapp_phone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_questionnaire_questions ON questionnaire_questions(questionnaire_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_questionnaire_assignments_contact ON questionnaire_assignments(contact_id);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_questionnaire_answers_question
    ON questionnaire_answers(cycle_id, question_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_jobs_due ON inbound_jobs(status, available_at);
  CREATE INDEX IF NOT EXISTS idx_outbound_outbox_due ON outbound_outbox(status, available_at);
  CREATE INDEX IF NOT EXISTS idx_forms_documents_kind ON forms_documents(kind, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_forms_document_lines_doc ON forms_document_lines(document_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_forms_partners_role ON forms_partners(is_customer, is_vendor);
  CREATE TABLE IF NOT EXISTS forms_presets (
    id TEXT PRIMARY KEY,
    company_odoo_id TEXT NOT NULL DEFAULT '1',
    kind TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    header_json TEXT NOT NULL DEFAULT '{}',
    lines_json TEXT NOT NULL DEFAULT '[]',
    visible_json TEXT NOT NULL DEFAULT '{}',
    bot_enabled INTEGER NOT NULL DEFAULT 0,
    bot_frequency TEXT NOT NULL DEFAULT 'daily',
    bot_weekday INTEGER NOT NULL DEFAULT 1,
    bot_send_time TEXT NOT NULL DEFAULT '08:00',
    bot_template_id TEXT NOT NULL DEFAULT '',
    bot_contact_id TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_forms_presets_company_kind
    ON forms_presets(company_odoo_id, kind, sort_order, name);
`;

const DEFAULT_PROMPT = `Você é o assistente de WhatsApp da Vértice Inovação.
Responda em português do Brasil, de forma curta, clara e educada.
Use apenas o conhecimento e as regras deste prompt. Não invente preços, prazos ou promessas.
Se não souber a resposta ou faltar informação, diga claramente que vai passar o atendimento para um atendente humano e peça para aguardar.
Não mencione que você é um modelo de linguagem.`;

async function migrate(): Promise<void> {
  await run(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instructions TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS message_id TEXT NOT NULL DEFAULT ''`);
  await run(
    `CREATE TABLE IF NOT EXISTS forms_partners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_key TEXT NOT NULL DEFAULT '',
      is_customer INTEGER NOT NULL DEFAULT 0,
      is_vendor INTEGER NOT NULL DEFAULT 0,
      odoo_id TEXT NOT NULL DEFAULT '',
      company_odoo_id TEXT NOT NULL DEFAULT '1',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await run(`ALTER TABLE forms_partners ADD COLUMN IF NOT EXISTS odoo_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_partners ADD COLUMN IF NOT EXISTS company_odoo_id TEXT NOT NULL DEFAULT '1'`);
  await run(`ALTER TABLE forms_documents ADD COLUMN IF NOT EXISTS company_odoo_id TEXT NOT NULL DEFAULT '1'`);
  await run(
    `CREATE TABLE IF NOT EXISTS forms_companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      vat TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT '',
      partner_odoo_id TEXT NOT NULL DEFAULT '',
      country_odoo_id TEXT NOT NULL DEFAULT '',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await run(`ALTER TABLE forms_companies ADD COLUMN IF NOT EXISTS country_odoo_id TEXT NOT NULL DEFAULT ''`);
  await run(`
    CREATE TABLE IF NOT EXISTS panel_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      company_odoo_id TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_panel_users_company ON panel_users(company_odoo_id)`);
  await run(`ALTER TABLE forms_partners ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_partners ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_partners ADD COLUMN IF NOT EXISTS vat TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_partners ADD COLUMN IF NOT EXISTS street TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_partners ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_partners ADD COLUMN IF NOT EXISTS is_company INTEGER NOT NULL DEFAULT 0`);
  await run(`UPDATE forms_documents SET company_odoo_id = '1' WHERE company_odoo_id IS NULL OR company_odoo_id = ''`);
  await run(`UPDATE forms_partners SET company_odoo_id = '1' WHERE company_odoo_id IS NULL OR company_odoo_id = ''`);
  await run(`ALTER TABLE forms_partners DROP CONSTRAINT IF EXISTS forms_partners_name_key_key`);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_forms_partners_company_name
     ON forms_partners(company_odoo_id, name_key)`,
  );
  await run(`CREATE INDEX IF NOT EXISTS idx_forms_documents_company ON forms_documents(company_odoo_id, kind)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_forms_partners_company ON forms_partners(company_odoo_id)`);
  await run(`
    CREATE TABLE IF NOT EXISTS forms_presets (
      id TEXT PRIMARY KEY,
      company_odoo_id TEXT NOT NULL DEFAULT '1',
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      header_json TEXT NOT NULL DEFAULT '{}',
      lines_json TEXT NOT NULL DEFAULT '[]',
      visible_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS visible_json TEXT NOT NULL DEFAULT '{}'`);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS bot_enabled INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS bot_frequency TEXT NOT NULL DEFAULT 'daily'`);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS bot_weekday INTEGER NOT NULL DEFAULT 1`);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS bot_send_time TEXT NOT NULL DEFAULT '08:00'`);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS bot_template_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS bot_contact_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE forms_presets ADD COLUMN IF NOT EXISTS bot_rules_json TEXT NOT NULL DEFAULT '{}'`);
  await run(`ALTER TABLE panel_users ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE questionnaires ADD COLUMN IF NOT EXISTS source_preset_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE questionnaires ADD COLUMN IF NOT EXISTS form_kind TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE questionnaires ADD COLUMN IF NOT EXISTS company_odoo_id TEXT NOT NULL DEFAULT ''`);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_questionnaires_source_preset
     ON questionnaires(source_preset_id) WHERE source_preset_id <> ''`,
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_forms_presets_company_kind
     ON forms_presets(company_odoo_id, kind, sort_order, name)`,
  );
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_forms_presets_company_kind_name
     ON forms_presets(company_odoo_id, kind, lower(name))`,
  );
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
  await run(
    `CREATE INDEX IF NOT EXISTS idx_forms_odoo_refs_type_name ON forms_odoo_refs(ref_type, name_key)`,
  );
  const constraints = await many<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'public.dispatches'::regclass AND contype = 'u'`,
  );
  for (const constraint of constraints) {
    if (!/^[a-z0-9_]+$/.test(constraint.conname)) continue;
    await run(`ALTER TABLE dispatches DROP CONSTRAINT ${constraint.conname}`);
  }
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_dispatches_message_day ON dispatches(message_id, scheduled_for)`,
  );
  await run(`CREATE INDEX IF NOT EXISTS idx_contact_messages_contact ON contact_messages(contact_id)`);
  await run(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS human_handoff INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS awaiting_human INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS human_unread INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'contact'`);
  await run(
    `UPDATE messages SET origin = 'whatsapp' WHERE direction = 'OUTBOUND' AND origin = 'contact'`,
  );
  await run(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS hidden INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS hidden INTEGER NOT NULL DEFAULT 0`);
  await run(`CREATE INDEX IF NOT EXISTS idx_questionnaire_questions ON questionnaire_questions(questionnaire_id, sort_order)`);
  await run(
    `CREATE TABLE IF NOT EXISTS questionnaire_assignments (
      questionnaire_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (questionnaire_id, contact_id)
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS questionnaire_cycles (
      id TEXT PRIMARY KEY,
      questionnaire_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      occurrence_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      template_sent_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      superseded_at TEXT NOT NULL DEFAULT '',
      pending_question_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS questionnaire_answers (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      answer_text TEXT NOT NULL DEFAULT '',
      answer_type TEXT NOT NULL DEFAULT 'text',
      media_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  await run(`CREATE INDEX IF NOT EXISTS idx_questionnaire_assignments_contact ON questionnaire_assignments(contact_id)`);
  // Um ciclo "vivo" por dia; ciclos substituídos (reenvio manual) ficam no histórico com superseded_at.
  await run(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS superseded_at TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS pending_question_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS pending_question_set_by TEXT NOT NULL DEFAULT ''`);
  await run(`DROP INDEX IF EXISTS ux_questionnaire_cycles_day`);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_questionnaire_cycles_active_day
     ON questionnaire_cycles(questionnaire_id, contact_id, occurrence_date)
     WHERE superseded_at = ''`,
  );
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_questionnaire_answers_question
     ON questionnaire_answers(cycle_id, question_id)`,
  );
  await run(
    `ALTER TABLE questionnaire_questions ADD COLUMN IF NOT EXISTS export_field TEXT NOT NULL DEFAULT ''`,
  );
  await migrateQuestionFixedValue();
  await run(`ALTER TABLE questionnaires ADD COLUMN IF NOT EXISTS template_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE questionnaires ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`);
  await run(`ALTER TABLE questionnaires ADD COLUMN IF NOT EXISTS deleted_at TEXT NOT NULL DEFAULT ''`);
  await run(
    `ALTER TABLE questionnaires ADD COLUMN IF NOT EXISTS default_values_json TEXT NOT NULL DEFAULT '{}'`,
  );
  await run(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS revision_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS last_prompted_at TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS last_inbound_at TEXT NOT NULL DEFAULT ''`);
  await run(
    `UPDATE questionnaires
     SET template_id = COALESCE(NULLIF(template_id, ''), (SELECT value FROM settings WHERE key = 'questionnaire_template_id'), '')
     WHERE template_id = ''`,
  );
  await backfillQuestionnaireRevisions();
  await ensureQuestionnaireConstraints();
  await rekeyFormsPartners();
}

/**
 * Valor fixado pelo padrão Forms numa pergunta (ex.: produto de “Qtd de ABACATE?”).
 * Perguntas antigas só tinham isso no texto: preenche uma vez a partir do corpo.
 */
async function migrateQuestionFixedValue(): Promise<void> {
  for (const table of ['questionnaire_questions', 'questionnaire_revision_questions']) {
    await run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS fixed_value TEXT NOT NULL DEFAULT ''`);
    await run(
      `UPDATE ${table}
       SET fixed_value = trim(substring(body from '^Qtd de (.+)\\?$'))
       WHERE export_field = '__lines__' AND fixed_value = '' AND body ~ '^Qtd de .+\\?$'`,
    );
    await run(
      `UPDATE ${table}
       SET fixed_value = trim(substring(body from '\\(padrão: (.+)\\)\\s*$'))
       WHERE export_field = '__lines__' AND fixed_value = ''
         AND body ~ '\\(padrão: .+\\)\\s*$'
         AND position('produto' in lower(split_part(body, '(padrão:', 1))) = 0`,
    );
  }
}

const PARTNER_KEY_VERSION_SETTING = 'forms_partners_name_key_version';
const PARTNER_KEY_VERSION = '2';

/** Recalcula name_key (sem acento / U+FFFD) uma vez; mantém a chave antiga se colidir. */
async function rekeyFormsPartners(): Promise<void> {
  const current = await one<{ value: string }>('SELECT value FROM settings WHERE key = $1', [
    PARTNER_KEY_VERSION_SETTING,
  ]);
  if (current?.value === PARTNER_KEY_VERSION) return;
  const rows = await many<{ id: string; name: string; name_key: string; company_odoo_id: string }>(
    'SELECT id, name, name_key, company_odoo_id FROM forms_partners',
  );
  let updated = 0;
  let conflicts = 0;
  for (const row of rows) {
    const key = partnerNameKey(row.name);
    if (!key || key === row.name_key) continue;
    const clash = await one<{ id: string }>(
      `SELECT id FROM forms_partners WHERE company_odoo_id = $1 AND name_key = $2 AND id <> $3 LIMIT 1`,
      [row.company_odoo_id, key, row.id],
    );
    if (clash) {
      conflicts += 1;
      console.warn(`forms_partners: "${row.name}" colide com ${clash.id} após normalização — mantido`);
      continue;
    }
    await run('UPDATE forms_partners SET name_key = $2 WHERE id = $1', [row.id, key]);
    updated += 1;
  }
  if (updated || conflicts) {
    console.log(`forms_partners: name_key normalizado (${updated} atualizados, ${conflicts} conflitos)`);
  }
  await run(
    `INSERT INTO settings(key, value) VALUES($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [PARTNER_KEY_VERSION_SETTING, PARTNER_KEY_VERSION],
  );
}

async function backfillQuestionnaireRevisions(): Promise<void> {
  await run(
    `INSERT INTO questionnaire_revisions(
       id, questionnaire_id, version, name, greeting, frequency, weekday, send_time, template_id, created_at
     )
     SELECT q.id || ':v' || q.version, q.id, q.version, q.name, q.greeting,
            q.frequency, q.weekday, q.send_time, q.template_id, q.updated_at
     FROM questionnaires q
     ON CONFLICT(questionnaire_id, version) DO NOTHING`,
  );
  await run(
    `INSERT INTO questionnaire_revision_questions(
       revision_id, question_id, body, expected_type, export_field, sort_order
     )
     SELECT rev.id, qq.id, qq.body, qq.expected_type,
            COALESCE(qq.export_field, ''), qq.sort_order
     FROM questionnaire_questions qq
     JOIN questionnaires q ON q.id = qq.questionnaire_id
     JOIN questionnaire_revisions rev
       ON rev.questionnaire_id = q.id AND rev.version = q.version
     ON CONFLICT(revision_id, question_id) DO NOTHING`,
  );
  await run(
    `UPDATE questionnaire_cycles cyc
     SET revision_id = rev.id
     FROM questionnaires q
     JOIN questionnaire_revisions rev
       ON rev.questionnaire_id = q.id AND rev.version = q.version
     WHERE q.id = cyc.questionnaire_id AND cyc.revision_id = ''`,
  );
}

async function ensureQuestionnaireConstraints(): Promise<void> {
  const constraints = [
    {
      name: 'fk_questionnaire_revision_questionnaire',
      table: 'questionnaire_revisions',
      clause: 'FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE RESTRICT',
    },
    {
      name: 'fk_revision_question_revision',
      table: 'questionnaire_revision_questions',
      clause: 'FOREIGN KEY (revision_id) REFERENCES questionnaire_revisions(id) ON DELETE CASCADE',
    },
    {
      name: 'fk_questionnaire_cycle_revision',
      table: 'questionnaire_cycles',
      clause: 'FOREIGN KEY (revision_id) REFERENCES questionnaire_revisions(id) ON DELETE RESTRICT',
    },
    {
      name: 'fk_questionnaire_answer_cycle',
      table: 'questionnaire_answers',
      clause: 'FOREIGN KEY (cycle_id) REFERENCES questionnaire_cycles(id) ON DELETE CASCADE',
    },
  ];
  for (const constraint of constraints) {
    await run(
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraint.name}') THEN
           ALTER TABLE ${constraint.table}
           ADD CONSTRAINT ${constraint.name} ${constraint.clause} NOT VALID;
         END IF;
       END $$`,
    );
  }
}

async function seedSettings(): Promise<void> {
  const defaults: Record<string, string> = {
    agent_name: 'Assistente Vértice',
    agent_prompt: DEFAULT_PROMPT,
    agent_model: env('OPENAI_MODEL', 'gpt-4o-mini'),
    agent_base_url: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    agent_api_key: env('OPENAI_API_KEY', ''),
    agent_temperature: '0.4',
    agent_active: '1',
    agent_auto_reply: '0',
    agent_fallback: 'Recebi sua mensagem. Em instantes alguém da Vértice Inovação continua o atendimento.',
    agent_history: '16',
    bot_menu_enabled: '1',
    bot_menu_intro: 'O que deseja fazer hoje?',
    bot_menu_session_hours: '2',
    bot_menu_attendant: '1',
    bot_reminder_time: '08:00',
    bot_reminder_days: 'daily',
    nevoa_base_url: env(
      'NEVOA_BASE_URL',
      'https://nevoa-manager-backend-9e27f965f73e.herokuapp.com/api/public/v1',
    ),
    nevoa_token: env('NEVOA_API_TOKEN', ''),
    nevoa_webhook_secret: env('NEVOA_WEBHOOK_SECRET', ''),
    nevoa_channel_id: env('NEVOA_CHANNEL_ID', ''),
    timezone: env('TIMEZONE', 'America/Sao_Paulo'),
    public_base_url: '',
    questionnaire_template_id: '',
    first_contact_template_id: '',
    agent_transcribe_model: env('OPENAI_TRANSCRIBE_MODEL', 'whisper-1'),
    odoo_url: env('ODOO_URL', 'https://www.reciclarenda.com.br'),
    odoo_db: env('ODOO_DB', ''),
    odoo_login: env('ODOO_LOGIN', ''),
    odoo_api_key: env('ODOO_API_KEY', ''),
    odoo_active_company_id: env('ODOO_ACTIVE_COMPANY_ID', '1'),
  };
  for (const [key, value] of Object.entries(defaults)) {
    await run('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING', [key, value]);
  }
}

async function importLocalSqlite(): Promise<void> {
  const existing = await one<{ total: number }>('SELECT COUNT(*)::int AS total FROM settings');
  if (existing && existing.total > 0) return;
  const file = path.resolve(env('DATABASE_PATH', './data/vertice.sqlite'));
  if (!existsSync(file)) return;
  const sqlite = new DatabaseSync(file);
  const tables = ['contacts', 'roteiros', 'conversations', 'messages', 'events', 'dispatches', 'settings'] as const;
  for (const table of tables) {
    try {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      for (const row of rows) await insertRow(table, row);
    } catch {
      // Tabela local ausente ou vazia: segue para a próxima.
    }
  }
}

async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  const columns = await many<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
    ['public', table],
  );
  const allowed = new Set(columns.map((column) => column.column_name));
  const keys = Object.keys(row).filter((key) => allowed.has(key) && row[key] !== undefined);
  if (!keys.length) return;
  const slots = keys.map((_, index) => `$${index + 1}`).join(', ');
  await run(
    `INSERT INTO ${table}(${keys.join(', ')}) VALUES(${slots}) ON CONFLICT DO NOTHING`,
    keys.map((key) => row[key]),
  );
}
