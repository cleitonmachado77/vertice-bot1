import { requireAuth } from './auth.js';
import { getActiveCompanyId } from './forms-companies.js';
import { isAdm, type PublicUser } from './users.js';
import { listAgroCatalog } from './agro-catalog.js';
import { agroBotFields, agroTabKind } from './agro-bot-fields.js';
import { removeAgroPreset, sendAgroBotPresetNow, syncAgroBotQuestionnaire } from './agro-bot.js';
import { listAgroPresets, saveAgroPreset } from './agro-presets.js';
import {
  agroOverview,
  deleteDelivery,
  deleteHarvest,
  deletePlanting,
  saveDelivery,
  saveHarvest,
  savePlanting,
} from './agro.js';
import { json, route, type Ctx } from './http.js';

function companyIdOf(user: PublicUser): string {
  if (!isAdm(user) && user.companyOdooId.trim()) return user.companyOdooId.trim();
  return getActiveCompanyId();
}

function body(ctx: Ctx): Record<string, unknown> {
  return ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, unknown>) : {};
}

function fail(ctx: Ctx, error: unknown, status = 400): void {
  const message = error instanceof Error ? error.message : 'Erro interno';
  json(ctx.res, status, { error: message });
}

export function registerAgroRoutes(): void {
  route('GET', '/api/agro', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, await agroOverview(companyIdOf(user)));
    } catch (error) {
      fail(ctx, error, 500);
    }
  });

  route('POST', '/api/agro/plantings', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, { item: await savePlanting(companyIdOf(user), body(ctx)) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/agro/plantings/:id', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, { item: await savePlanting(companyIdOf(user), body(ctx), ctx.params.id) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/agro/plantings/:id', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      await deletePlanting(companyIdOf(user), ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/agro/harvests', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, { item: await saveHarvest(companyIdOf(user), body(ctx)) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/agro/harvests/:id', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, { item: await saveHarvest(companyIdOf(user), body(ctx), ctx.params.id) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/agro/harvests/:id', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      await deleteHarvest(companyIdOf(user), ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/agro/deliveries', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, { item: await saveDelivery(companyIdOf(user), body(ctx)) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/agro/deliveries/:id', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, { item: await saveDelivery(companyIdOf(user), body(ctx), ctx.params.id) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/agro/presets', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      const companyId = companyIdOf(user);
      const kind = agroTabKind(String(ctx.query.get('kind') || ''));
      const catalog = await listAgroCatalog(companyId);
      json(ctx.res, 200, {
        kind,
        fields: agroBotFields(kind),
        items: await listAgroPresets(companyId, kind),
        catalog: {
          producers: catalog.producers,
          products: catalog.products,
          buyers: catalog.buyers,
        },
      });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/agro/presets', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      const companyId = companyIdOf(user);
      const preset = await saveAgroPreset(companyId, body(ctx));
      await syncAgroBotQuestionnaire(preset);
      json(ctx.res, 200, { item: preset });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('PUT', '/api/agro/presets/:id', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      const companyId = companyIdOf(user);
      const preset = await saveAgroPreset(companyId, body(ctx), ctx.params.id);
      await syncAgroBotQuestionnaire(preset);
      json(ctx.res, 200, { item: preset });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/agro/presets/:id/bot-send', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, await sendAgroBotPresetNow(companyIdOf(user), ctx.params.id));
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/agro/presets/:id', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      await removeAgroPreset(companyIdOf(user), ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/agro/deliveries/:id', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    try {
      await deleteDelivery(companyIdOf(user), ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });
}
