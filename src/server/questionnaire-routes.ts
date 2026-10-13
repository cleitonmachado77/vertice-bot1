import { json, route, type Ctx } from './http.js';
import { hasSession } from './auth.js';
import { getSetting, setSetting } from './db.js';
import { asList } from './map.js';
import { listTemplates } from './nevoa.js';
import { listCollectedData } from './questionnaire-cycles.js';
import {
  deleteQuestionnaire,
  listQuestionnaires,
  previewQuestionnaireBody,
  saveQuestionnaire,
} from './questionnaires.js';

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

function fail(ctx: Ctx, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Erro interno';
  json(ctx.res, 400, { error: message });
}

export function registerQuestionnaireRoutes(): void {
  route('GET', '/api/questionnaires', async (ctx) => {
    if (!requireUser(ctx)) return;
    const items = await listQuestionnaires();
    json(ctx.res, 200, {
      items: items.map((item) => ({
        ...item,
        preview: previewQuestionnaireBody(item.greeting, item.questions),
      })),
      templateId: getSetting('questionnaire_template_id'),
    });
  });

  route('GET', '/api/questionnaires/data', async (ctx) => {
    if (!requireUser(ctx)) return;
    const questionnaireId = ctx.query.get('questionnaireId') || '';
    json(ctx.res, 200, { items: await listCollectedData(questionnaireId) });
  });

  route('PUT', '/api/questionnaires/settings', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const templateId = text(body(ctx).templateId).trim();
      await setSetting('questionnaire_template_id', templateId);
      json(ctx.res, 200, { ok: true, templateId });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/questionnaires', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      json(ctx.res, 200, { item: await saveFrom(ctx) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('PUT', '/api/questionnaires/:id', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      json(ctx.res, 200, { item: await saveFrom(ctx, ctx.params.id) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/questionnaires/:id', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      await deleteQuestionnaire(ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/questionnaires/templates', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const payload = await listTemplates(getSetting('nevoa_channel_id'));
      const items = asList(payload)
        .map((row) => ({
          id: String(row.id || ''),
          name: String(row.name || row.externalTemplateName || 'Template'),
          body: String(row.body || ''),
          status: String(row.status || ''),
        }))
        .filter((item) => item.id && item.status === 'APPROVED');
      json(ctx.res, 200, {
        items,
        selectedId: getSetting('questionnaire_template_id'),
      });
    } catch (error) {
      fail(ctx, error);
    }
  });
}

async function saveFrom(ctx: Ctx, id = '') {
  const input = body(ctx);
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const contactIds = Array.isArray(input.contactIds)
    ? input.contactIds.map((item) => String(item || '')).filter(Boolean)
    : [];
  return saveQuestionnaire({
    id: id || undefined,
    name: text(input.name),
    greeting: text(input.greeting),
    frequency: text(input.frequency, 'daily'),
    weekday: Number(input.weekday ?? 1),
    sendTime: text(input.sendTime, '09:00'),
    active: input.active !== false,
    contactIds,
    questions: questions.map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        id: text(row.id) || undefined,
        body: text(row.body),
        expectedType: text(row.expectedType, 'any'),
      };
    }),
  });
}
