import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { databaseConnectionString } from './database-url.js';
import { env } from './env.js';

const cache = new Map<string, string>();
let pool: pg.Pool | undefined;

export async function many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await many<T>(sql, params);
  return rows[0];
}

export async function run(sql: string, params: unknown[] = []): Promise<void> {
  await getPool().query(sql, params);
}

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
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`;

const DEFAULT_PROMPT = `Você é o assistente de WhatsApp da Vértice Inovação.
Responda em português do Brasil, de forma curta, clara e educada.
Siga o roteiro do contato.
Não invente preços, prazos ou promessas. Se faltar informação, diga que um atendente humano vai continuar.
Não mencione que você é um modelo de linguagem.`;

async function migrate(): Promise<void> {
  await run(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instructions TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS message_id TEXT NOT NULL DEFAULT ''`);
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
  await run(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'contact'`);
  await run(
    `UPDATE messages SET origin = 'whatsapp' WHERE direction = 'OUTBOUND' AND origin = 'contact'`,
  );
  await run(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS hidden INTEGER NOT NULL DEFAULT 0`);
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
    agent_history: '8',
    nevoa_base_url: env(
      'NEVOA_BASE_URL',
      'https://nevoa-manager-backend-9e27f965f73e.herokuapp.com/api/public/v1',
    ),
    nevoa_token: env('NEVOA_API_TOKEN', ''),
    nevoa_webhook_secret: env('NEVOA_WEBHOOK_SECRET', ''),
    nevoa_channel_id: env('NEVOA_CHANNEL_ID', ''),
    timezone: env('TIMEZONE', 'America/Sao_Paulo'),
    public_base_url: '',
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
