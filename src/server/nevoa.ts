import { getSetting } from './db.js';
import { asList } from './map.js';

export class NevoaError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, payload: unknown) {
    const message = describeNevoaError(payload, status);
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function baseUrl(): string {
  return getSetting('nevoa_base_url').replace(/\/$/, '');
}

function token(): string {
  const value = getSetting('nevoa_token');
  if (!value) throw new NevoaError(500, { message: 'API Token da Névoa não configurado' });
  return value;
}

export async function nevoaRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok) throw new NevoaError(response.status, payload);
  return payload;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export async function nevoaList(path: string): Promise<Record<string, unknown>[]> {
  const first = (await nevoaRequest('GET', `${path}${path.includes('?') ? '&' : '?'}limit=50`)) as {
    next_cursor?: string;
    total?: number;
    page?: number;
    limit?: number;
  };
  const items = asList(first);
  if (first.next_cursor) {
    let cursor: string | undefined = first.next_cursor;
    for (let page = 0; page < 10 && cursor; page += 1) {
      const next = (await nevoaRequest(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}limit=50&cursor=${encodeURIComponent(cursor)}`,
      )) as { next_cursor?: string };
      items.push(...asList(next));
      cursor = next.next_cursor;
    }
    return items;
  }
  const total = Number(first.total || items.length);
  const limit = Number(first.limit || 50);
  let page = Number(first.page || 1);
  while (page * limit < total && page < 20) {
    page += 1;
    const next = await nevoaRequest('GET', `${path}${path.includes('?') ? '&' : '?'}limit=${limit}&page=${page}`);
    items.push(...asList(next));
  }
  return items;
}

export async function sendWhatsappText(input: {
  phone: string;
  text: string;
  channelIntegrationId?: string;
}): Promise<unknown> {
  return nevoaRequest('POST', '/messages', {
    phone: input.phone,
    type: 'TEXT',
    text: input.text,
    ...(input.channelIntegrationId ? { channelIntegrationId: input.channelIntegrationId } : {}),
  });
}

export async function listTemplates(channelIntegrationId: string): Promise<unknown> {
  const query = channelIntegrationId
    ? `?channelIntegrationId=${encodeURIComponent(channelIntegrationId)}`
    : '';
  return nevoaRequest('GET', `/templates${query}`);
}

export async function sendWhatsappTemplate(input: {
  templateId: string;
  phone: string;
  variables: string[];
  channelIntegrationId?: string;
}): Promise<unknown> {
  return nevoaRequest('POST', '/messages/template', {
    templateId: input.templateId,
    phone: input.phone,
    variables: input.variables,
    ...(input.channelIntegrationId ? { channelIntegrationId: input.channelIntegrationId } : {}),
  });
}

function describeNevoaError(payload: unknown, status: number): string {
  if (!payload || typeof payload !== 'object') return `Névoa respondeu ${status}`;
  const record = payload as { message?: unknown; error?: { code?: number; message?: unknown } };
  if (record.error?.code === 132000) return 'A quantidade de variáveis não confere com o template aprovado.';
  if (typeof record.error?.message === 'string' && record.error.message) return record.error.message;
  if (typeof record.message === 'string' && record.message) return record.message;
  if (Array.isArray(record.message)) return record.message.map(String).join(' ');
  return `Névoa respondeu ${status}`;
}
