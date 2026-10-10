import { zonedNow } from './clock.js';
import { json, route, type Ctx } from './http.js';
import { hasSession } from './auth.js';
import { runDueDispatches } from './dispatch.js';
import {
  deleteRoteiro,
  listDispatches,
  listRoteiros,
  saveRoteiro,
} from './roteiros.js';

function requireUser(ctx: Ctx): boolean {
  if (hasSession(ctx.req.headers.cookie)) return true;
  json(ctx.res, 401, { error: 'Faça login' });
  return false;
}

function body(ctx: Ctx): Record<string, unknown> {
  return ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, unknown>) : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function registerRoteiroRoutes(): void {
  route('GET', '/api/roteiros', async (ctx) => {
    if (!requireUser(ctx)) return;
    json(ctx.res, 200, { items: await listRoteiros(), dispatches: await listDispatches(zonedNow().date) });
  });

  route('POST', '/api/roteiros', async (ctx) => {
    if (!requireUser(ctx)) return;
    json(ctx.res, 200, await saveFrom(ctx, ''));
  });

  route('PUT', '/api/roteiros/:id', async (ctx) => {
    if (!requireUser(ctx)) return;
    json(ctx.res, 200, await saveFrom(ctx, ctx.params.id));
  });

  route('DELETE', '/api/roteiros/:id', async (ctx) => {
    if (!requireUser(ctx)) return;
    await deleteRoteiro(ctx.params.id);
    json(ctx.res, 200, { ok: true });
  });

  route('POST', '/api/dispatches/run', async (ctx) => {
    if (!requireUser(ctx)) return;
    json(ctx.res, 200, await runDueDispatches());
  });
}

async function saveFrom(ctx: Ctx, id: string) {
  const input = body(ctx);
  const name = text(input.name).trim();
  const sendTime = text(input.sendTime, '09:00');
  if (!name) throw new Error('Dê um nome ao roteiro');
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(sendTime)) throw new Error('Horário inválido. Use HH:MM');
  return await saveRoteiro({
    id: id || undefined,
    name,
    instructions: text(input.instructions),
    dailyMessage: text(input.dailyMessage),
    sendTime,
    active: input.active !== false,
  });
}
