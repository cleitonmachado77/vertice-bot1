import { getSetting } from './db.js';

export type OdooConfig = {
  url: string;
  db: string;
  login: string;
  apiKey: string;
};

export class OdooError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdooError';
  }
}

export function getOdooConfig(): OdooConfig {
  return {
    url: (getSetting('odoo_url') || '').replace(/\/$/, ''),
    db: getSetting('odoo_db') || '',
    login: getSetting('odoo_login') || '',
    apiKey: getSetting('odoo_api_key') || '',
  };
}

export function odooConfigured(config = getOdooConfig()): boolean {
  return Boolean(config.url && config.db && config.login && config.apiKey);
}

type JsonRpcReply = {
  result?: unknown;
  error?: { message?: string; data?: { message?: string } };
};

const ODOO_RPC_TIMEOUT_MS = 90_000;

async function jsonRpc(config: OdooConfig, service: string, method: string, args: unknown[]): Promise<unknown> {
  if (!config.url) throw new OdooError('URL do Odoo não configurada');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ODOO_RPC_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: Date.now(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new OdooError(`Odoo HTTP ${response.status}`);
    }
    const payload = (await response.json()) as JsonRpcReply;
    if (payload.error) {
      const detail = payload.error.data?.message || payload.error.message || 'Erro RPC Odoo';
      throw new OdooError(detail);
    }
    return payload.result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new OdooError(`Timeout ao falar com o Odoo (${ODOO_RPC_TIMEOUT_MS / 1000}s)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type AuthCache = { key: string; uid: number; at: number };
let authCache: AuthCache | null = null;
const AUTH_TTL_MS = 5 * 60 * 1000;

export async function odooVersion(config = getOdooConfig()): Promise<Record<string, unknown>> {
  const result = await jsonRpc(config, 'common', 'version', []);
  return (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
}

export async function odooAuthenticate(config = getOdooConfig()): Promise<number> {
  if (!odooConfigured(config)) {
    throw new OdooError('Configure URL, banco, login e API Key do Odoo');
  }
  const key = `${config.url}|${config.db}|${config.login}|${config.apiKey}`;
  if (authCache && authCache.key === key && Date.now() - authCache.at < AUTH_TTL_MS) {
    return authCache.uid;
  }
  const uid = await jsonRpc(config, 'common', 'authenticate', [config.db, config.login, config.apiKey, {}]);
  if (!uid || typeof uid !== 'number') {
    throw new OdooError('Falha na autenticação Odoo (verifique banco, login e API Key)');
  }
  authCache = { key, uid, at: Date.now() };
  return uid;
}

export async function odooExecuteKw<T = unknown>(
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
  config = getOdooConfig(),
): Promise<T> {
  const uid = await odooAuthenticate(config);
  const result = await jsonRpc(config, 'object', 'execute_kw', [
    config.db,
    uid,
    config.apiKey,
    model,
    method,
    args,
    kwargs,
  ]);
  return result as T;
}

export async function odooSearchRead<T extends Record<string, unknown>>(
  model: string,
  domain: unknown[] = [],
  fields: string[] = [],
  extras: { limit?: number; offset?: number; order?: string } = {},
): Promise<T[]> {
  const kwargs: Record<string, unknown> = { fields };
  if (extras.limit != null) kwargs.limit = extras.limit;
  if (extras.offset != null) kwargs.offset = extras.offset;
  if (extras.order) kwargs.order = extras.order;
  const rows = await odooExecuteKw<T[]>(model, 'search_read', [domain], kwargs);
  return Array.isArray(rows) ? rows : [];
}

export async function odooCreate(model: string, values: Record<string, unknown>): Promise<number> {
  const id = await odooExecuteKw<number>(model, 'create', [values]);
  if (typeof id !== 'number') throw new OdooError(`create(${model}) não retornou id`);
  return id;
}

export async function odooWrite(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean> {
  const ok = await odooExecuteKw<boolean>(model, 'write', [ids, values]);
  return Boolean(ok);
}

type FieldPresenceCache = { at: number; present: boolean };
const fieldPresenceCache = new Map<string, FieldPresenceCache>();
const FIELD_PRESENCE_TTL_MS = 30 * 60 * 1000;

/** Cacheia se um campo existe no modelo (útil para diferenças entre versões do Odoo). */
export async function odooModelHasField(model: string, field: string): Promise<boolean> {
  const key = `${model}:${field}`;
  const cached = fieldPresenceCache.get(key);
  if (cached && Date.now() - cached.at < FIELD_PRESENCE_TTL_MS) {
    return cached.present;
  }
  try {
    // Pedir só o campo: no Odoo 19 fields_get de campo inexistente pode lançar Invalid field.
    const result = await odooExecuteKw<Record<string, unknown>>(model, 'fields_get', [], {
      attributes: ['type'],
    });
    const present = Boolean(result && typeof result === 'object' && field in result);
    fieldPresenceCache.set(key, { at: Date.now(), present });
    return present;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/invalid field/i.test(message)) {
      fieldPresenceCache.set(key, { at: Date.now(), present: false });
      return false;
    }
    throw error;
  }
}

type OdooStatusCache = {
  at: number;
  value: {
    configured: boolean;
    connected: boolean;
    version?: string;
    uid?: number;
    error?: string;
  };
};

let statusCache: OdooStatusCache | null = null;
const STATUS_TTL_MS = 5 * 60 * 1000;

export async function odooStatus(options: { live?: boolean } = {}): Promise<{
  configured: boolean;
  connected: boolean;
  version?: string;
  uid?: number;
  error?: string;
  cached?: boolean;
}> {
  const config = getOdooConfig();
  if (!odooConfigured(config)) {
    return { configured: false, connected: false, error: 'Credenciais Odoo incompletas' };
  }
  if (!options.live && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return { ...statusCache.value, cached: true };
  }
  try {
    const version = await odooVersion(config);
    const uid = await odooAuthenticate(config);
    const value = {
      configured: true,
      connected: true,
      version: String(version.server_version || version.server_serie || ''),
      uid,
    };
    statusCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = {
      configured: true,
      connected: false,
      error: error instanceof Error ? error.message : 'Falha ao conectar',
    };
    statusCache = { at: Date.now(), value };
    return value;
  }
}
