import { json, route, type Ctx } from './http.js';
import { hasSession } from './auth.js';
import { zonedNow, minutesFromClock } from './clock.js';
import { getSetting, setSetting, many } from './db.js';
import { runDueDispatches } from './dispatch.js';
import { asList } from './map.js';
import { listTemplates } from './nevoa.js';
import { listCollectedData, listDueQuestionnaireSends } from './questionnaire-cycles.js';
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

  route('GET', '/api/questionnaires/dispatch-status', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const clock = zonedNow();
      const due = await listDueQuestionnaireSends(clock.weekday);
      const cycles = await many<{
        id: string;
        questionnaire_id: string;
        contact_id: string;
        occurrence_date: string;
        status: string;
        error: string;
        updated_at: string;
      }>(
        `SELECT id, questionnaire_id, contact_id, occurrence_date, status, error, updated_at
         FROM questionnaire_cycles
         WHERE occurrence_date = $1
         ORDER BY updated_at DESC
         LIMIT 30`,
        [clock.date],
      );
      let templates: { id: string; name: string }[] = [];
      let templateError = '';
      try {
        templates = asList(await listTemplates(getSetting('nevoa_channel_id')))
          .map((row) => ({
            id: String(row.id || ''),
            name: String(row.name || row.externalTemplateName || 'Template'),
            status: String(row.status || ''),
          }))
          .filter((item) => item.id && item.status === 'APPROVED')
          .map((item) => ({ id: item.id, name: item.name }));
      } catch (error) {
        templateError = error instanceof Error ? error.message : 'Falha ao listar templates';
      }
      json(ctx.res, 200, {
        clock: {
          date: clock.date,
          time: `${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`,
          minutes: clock.minutes,
          weekday: clock.weekday,
          timezone: getSetting('timezone', 'America/Sao_Paulo'),
        },
        channelId: getSetting('nevoa_channel_id') || '',
        templateId: getSetting('questionnaire_template_id') || '',
        templates,
        templateError,
        due: due.map((item) => ({
          ...item,
          dueNow: clock.minutes >= minutesFromClock(item.send_time),
        })),
        cyclesToday: cycles,
      });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/questionnaires/dispatch', async (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      json(ctx.res, 200, await runDueDispatches());
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
