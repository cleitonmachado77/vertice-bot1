import { requireAdm, requireAuth } from './auth.js';
import { getSetting, setSetting } from './db.js';
import { isAdm, type PublicUser } from './users.js';
import {
  KIND_LABELS,
  PRODUCT_FIELDS,
  PURCHASE_HEADER_FIELDS,
  PURCHASE_LINE_FIELDS,
  PURCHASE_ODOO_STATUSES,
  SALE_HEADER_FIELDS,
  SALE_LINE_FIELDS,
  SALE_ODOO_STATUSES,
  isFormKind,
  type FormKind,
} from './forms-fields.js';
import { getFormsCatalog } from './forms-catalog.js';
import {
  deleteEntityPartner,
  deleteEntityProduct,
  entitiesSummary,
  getEntityPartner,
  listEntityPartners,
  listEntityProducts,
  saveEntityPartner,
  saveEntityProduct,
} from './forms-entities.js';
import { pushPartnerToOdoo } from './forms-partner-sync.js';
import { exportFormById, exportFormsByKind } from './forms-export.js';
import {
  createFormDocument,
  deleteFormDocument,
  disablePublicLink,
  getFormDocument,
  listFormDocuments,
  saveFormDocument,
  type FormSaveInput,
} from './forms.js';
import {
  createFormPreset,
  deleteFormPreset,
  listFormPresets,
  updateFormPreset,
} from './forms-presets.js';
import {
  companiesPayload,
  setActiveCompanyId,
  syncCompaniesFromOdoo,
} from './forms-companies.js';
import { odooStatus } from './odoo-client.js';
import {
  archivePartnerInOdoo,
  assertFormOrderEditable,
  cancelFormInOdoo,
  getOdooPullProgress,
  markDocSyncPending,
  pullFromOdoo,
  pushAllFormsToOdoo,
  pushFormToOdoo,
  pushFormsByKind,
  pushProductToOdoo,
  scheduleOdooPush,
  schedulePartnerPush,
} from './odoo-sync.js';
import { json, route, type Ctx } from './http.js';

async function requireUser(ctx: Ctx): Promise<PublicUser | null> {
  return requireAuth(ctx);
}

function companyScope(user: PublicUser | null) {
  if (!user || isAdm(user)) return { canSwitchCompany: true as const };
  return { companyOdooId: user.companyOdooId, canSwitchCompany: false as const };
}

function body(ctx: Ctx): Record<string, unknown> {
  return ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, unknown>) : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = item == null ? '' : String(item);
  }
  return out;
}

function asPresetVisible(value: unknown): {
  title?: boolean;
  status?: boolean;
  header?: string[];
  lines?: string[];
} | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return {
    title: raw.title == null ? undefined : Boolean(raw.title),
    status: raw.status == null ? undefined : Boolean(raw.status),
    header: Array.isArray(raw.header) ? raw.header.map(String) : undefined,
    lines: Array.isArray(raw.lines) ? raw.lines.map(String) : undefined,
  };
}

function parseSave(raw: Record<string, unknown>): FormSaveInput {
  const linesRaw = Array.isArray(raw.lines) ? raw.lines : undefined;
  return {
    title: text(raw.title) || undefined,
    status: text(raw.status) || undefined,
    header: raw.header ? asRecord(raw.header) : undefined,
    lines: linesRaw?.map((line) => {
      const item = line && typeof line === 'object' ? (line as Record<string, unknown>) : {};
      return {
        id: text(item.id) || undefined,
        values: asRecord(item.values),
      };
    }),
  };
}

function fail(ctx: Ctx, error: unknown, status = 400): void {
  const message = error instanceof Error ? error.message : 'Erro interno';
  json(ctx.res, status, { error: message });
}

function sendWorkbook(ctx: Ctx, result: { buffer: Buffer; filename: string; rows: number }): void {
  ctx.res.writeHead(200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${result.filename}"`,
    'cache-control': 'no-store',
    'x-export-rows': String(result.rows),
  });
  ctx.res.end(result.buffer);
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function odooSettingsPayload() {
  const apiKey = getSetting('odoo_api_key');
  return {
    odooUrl: getSetting('odoo_url') || 'https://www.reciclarenda.com.br',
    odooDb: getSetting('odoo_db'),
    odooLogin: getSetting('odoo_login'),
    odooApiKey: maskSecret(apiKey),
    odooConfigured: Boolean(
      getSetting('odoo_url') && getSetting('odoo_db') && getSetting('odoo_login') && apiKey,
    ),
  };
}

function schema() {
  return {
    kinds: [
      { id: 'product', label: KIND_LABELS.product },
      { id: 'purchase', label: KIND_LABELS.purchase },
      { id: 'sale', label: KIND_LABELS.sale },
    ],
    fields: {
      sale: { header: SALE_HEADER_FIELDS, lines: SALE_LINE_FIELDS },
      purchase: { header: PURCHASE_HEADER_FIELDS, lines: PURCHASE_LINE_FIELDS },
      product: { header: PRODUCT_FIELDS, lines: [] },
    },
    statuses: {
      sale: SALE_ODOO_STATUSES,
      purchase: PURCHASE_ODOO_STATUSES,
      product: [],
    },
  };
}

export function registerFormsRoutes(): void {
  route('GET', '/api/forms/schema', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, schema());
  });

  route('GET', '/api/forms/catalog', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, await getFormsCatalog());
  });

  route('GET', '/api/forms/odoo/status', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const live = text(ctx.query.get('live')) === '1';
    // Por padrão não pinga o Odoo (lento). Usa cache / último pull do banco.
    const status = live
      ? await odooStatus({ live: true })
      : {
          configured: Boolean(
            getSetting('odoo_url') && getSetting('odoo_db') && getSetting('odoo_login') && getSetting('odoo_api_key'),
          ),
          connected: Boolean(getSetting('odoo_last_pull_at')),
          version: '',
          cached: true,
        };
    json(ctx.res, 200, {
      ...status,
      lastPullAt: getSetting('odoo_last_pull_at') || '',
      lastPull: {
        companies: Number(getSetting('odoo_last_pull_companies') || 0),
        products: Number(getSetting('odoo_last_pull_products') || 0),
        partners: Number(getSetting('odoo_last_pull_partners') || 0),
        sales: Number(getSetting('odoo_last_pull_sales') || 0),
        purchases: Number(getSetting('odoo_last_pull_purchases') || 0),
        stockUpdated: Number(getSetting('odoo_last_pull_stock') || 0),
      },
    });
  });

  route('GET', '/api/forms/companies', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    try {
      json(ctx.res, 200, await companiesPayload(companyScope(user)));
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/forms/companies/sync', async (ctx) => {
    if (!(await requireAdm(ctx))) return;
    try {
      const items = await syncCompaniesFromOdoo();
      json(ctx.res, 200, { ...(await companiesPayload({ canSwitchCompany: true })), synced: items.length });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('PUT', '/api/forms/companies/active', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    try {
      if (!isAdm(user)) {
        json(ctx.res, 403, { error: 'Gestores Entidade não podem trocar de empresa' });
        return;
      }
      const active = await setActiveCompanyId(text(body(ctx).activeId || body(ctx).id));
      json(ctx.res, 200, { ...(await companiesPayload({ canSwitchCompany: true })), active });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms/odoo/settings', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    json(ctx.res, 200, { ...odooSettingsPayload(), canEditOdoo: isAdm(user) });
  });

  route('PUT', '/api/forms/odoo/settings', async (ctx) => {
    if (!(await requireAdm(ctx))) return;
    try {
      const input = body(ctx);
      if (typeof input.odooUrl === 'string') {
        await setSetting(
          'odoo_url',
          text(input.odooUrl).replace(/\/$/, '') || 'https://www.reciclarenda.com.br',
        );
      }
      if (typeof input.odooDb === 'string') await setSetting('odoo_db', text(input.odooDb));
      if (typeof input.odooLogin === 'string') await setSetting('odoo_login', text(input.odooLogin));
      const apiKey = text(input.odooApiKey);
      if (apiKey && !apiKey.includes('••••')) await setSetting('odoo_api_key', apiKey);
      json(ctx.res, 200, { ...odooSettingsPayload(), canEditOdoo: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms/odoo/pull/progress', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, getOdooPullProgress());
  });

  route('POST', '/api/forms/odoo/pull', async (ctx) => {
    if (!(await requireAdm(ctx))) return;
    try {
      const input = body(ctx);
      const auto = input.auto === true || text(ctx.query.get('auto')) === '1';
      const result = await pullFromOdoo({ auto });
      // Não devolve catálogo completo aqui — pesa a resposta e deixa a UI “travada”.
      json(ctx.res, 200, {
        ok: true,
        ...result,
        summary: await entitiesSummary(),
      });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms/entities/summary', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, await entitiesSummary());
  });

  route('GET', '/api/forms/entities/products', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, { items: await listEntityProducts() });
  });

  route('POST', '/api/forms/entities/products', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const input = body(ctx);
      const item = await saveEntityProduct({
        name: text(input.name),
        category: text(input.category),
        sales_price: text(input.sales_price),
        cost: text(input.cost),
        uom: text(input.uom),
        internal_ref: text(input.internal_ref),
        qty_on_hand: text(input.qty_on_hand),
        track_inventory: text(input.track_inventory) || 'True',
      });
      await markDocSyncPending(item.id).catch(() => undefined);
      json(ctx.res, 200, { item, sync_status: 'syncing' });
      scheduleOdooPush(item.id);
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('PUT', '/api/forms/entities/products/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const input = body(ctx);
      const item = await saveEntityProduct({
        id: ctx.params.id,
        name: text(input.name),
        category: text(input.category),
        sales_price: text(input.sales_price),
        cost: text(input.cost),
        uom: text(input.uom),
        internal_ref: text(input.internal_ref),
        qty_on_hand: text(input.qty_on_hand),
        track_inventory: text(input.track_inventory) || 'True',
      });
      await markDocSyncPending(item.id).catch(() => undefined);
      json(ctx.res, 200, { item, sync_status: 'syncing' });
      scheduleOdooPush(item.id);
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/forms/entities/products/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const doc = await getFormDocument(ctx.params.id);
      if (doc?.kind === 'product') {
        try {
          await cancelFormInOdoo(doc);
        } catch (error) {
          console.error(
            `[odoo-auto-cancel-product] ${ctx.params.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      await deleteEntityProduct(ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/forms/entities/products/:id/odoo-push', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const doc = await getFormDocument(ctx.params.id);
      if (!doc || doc.kind !== 'product') throw new Error('Produto não encontrado');
      json(ctx.res, 200, { item: await pushProductToOdoo(doc) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms/entities/partners', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const role = text(ctx.query.get('role') || 'all');
    const safe = role === 'customer' || role === 'vendor' ? role : 'all';
    json(ctx.res, 200, { items: await listEntityPartners(safe) });
  });

  route('POST', '/api/forms/entities/partners', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const input = body(ctx);
      const item = await saveEntityPartner({
        name: text(input.name),
        is_customer: input.is_customer === true || input.is_customer === 1,
        is_vendor: input.is_vendor === true || input.is_vendor === 1,
        email: text(input.email),
        phone: text(input.phone),
        vat: text(input.vat),
        street: text(input.street),
        city: text(input.city),
        is_company: input.is_company === true || input.is_company === 1,
      });
      json(ctx.res, 200, { item, sync_status: 'syncing' });
      schedulePartnerPush(item.id);
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('PUT', '/api/forms/entities/partners/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const input = body(ctx);
      const item = await saveEntityPartner({
        id: ctx.params.id,
        name: text(input.name),
        is_customer: input.is_customer === true || input.is_customer === 1,
        is_vendor: input.is_vendor === true || input.is_vendor === 1,
        email: text(input.email),
        phone: text(input.phone),
        vat: text(input.vat),
        street: text(input.street),
        city: text(input.city),
        is_company: input.is_company === true || input.is_company === 1,
      });
      json(ctx.res, 200, { item, sync_status: 'syncing' });
      schedulePartnerPush(item.id);
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/forms/entities/partners/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const partner = await getEntityPartner(ctx.params.id);
      if (partner?.odoo_id) {
        try {
          await archivePartnerInOdoo(partner.odoo_id);
        } catch (error) {
          console.error(
            `[odoo-auto-archive-partner] ${ctx.params.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      await deleteEntityPartner(ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/forms/entities/partners/:id/odoo-push', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      json(ctx.res, 200, { item: await pushPartnerToOdoo(ctx.params.id) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/forms/odoo/push', async (ctx) => {
    if (!(await requireAdm(ctx))) return;
    try {
      const kind = text(ctx.query.get('kind') || body(ctx).kind || 'all');
      if (!kind || kind === 'all') {
        json(ctx.res, 200, await pushAllFormsToOdoo());
        return;
      }
      if (kind !== 'sale' && kind !== 'purchase' && kind !== 'product') {
        throw new Error('Informe kind=all|sale|purchase|product');
      }
      json(ctx.res, 200, await pushFormsByKind(kind));
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms/presets', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const kind = text(ctx.query.get('kind'));
      if (!isFormKind(kind)) throw new Error('Informe kind=sale|purchase|product');
      json(ctx.res, 200, { items: await listFormPresets(kind) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/forms/presets', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const raw = body(ctx);
      json(
        ctx.res,
        200,
        {
          item: await createFormPreset({
            kind: text(raw.kind),
            name: text(raw.name),
            title: text(raw.title),
            status: text(raw.status) || undefined,
            header: raw.header ? asRecord(raw.header) : undefined,
            lines: Array.isArray(raw.lines)
              ? raw.lines.map((line) => {
                  const item = line && typeof line === 'object' ? (line as Record<string, unknown>) : {};
                  return { values: asRecord(item.values) };
                })
              : undefined,
            visible: asPresetVisible(raw.visible),
            sort_order: raw.sort_order != null ? Number(raw.sort_order) : undefined,
          }),
        },
      );
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('PUT', '/api/forms/presets/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const raw = body(ctx);
      json(
        ctx.res,
        200,
        {
          item: await updateFormPreset(ctx.params.id, {
            name: raw.name != null ? text(raw.name) : undefined,
            title: raw.title != null ? text(raw.title) : undefined,
            status: raw.status != null ? text(raw.status) : undefined,
            header: raw.header ? asRecord(raw.header) : undefined,
            lines: Array.isArray(raw.lines)
              ? raw.lines.map((line) => {
                  const item = line && typeof line === 'object' ? (line as Record<string, unknown>) : {};
                  return { values: asRecord(item.values) };
                })
              : undefined,
            visible: raw.visible !== undefined ? asPresetVisible(raw.visible) : undefined,
            sort_order: raw.sort_order != null ? Number(raw.sort_order) : undefined,
          }),
        },
      );
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/forms/presets/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      await deleteFormPreset(ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const kind = text(ctx.query.get('kind'));
    if (!isFormKind(kind)) {
      json(ctx.res, 400, { error: 'Informe kind=sale|purchase|product' });
      return;
    }
    const includeLines = text(ctx.query.get('lines')) === '1';
    json(ctx.res, 200, { items: await listFormDocuments(kind, { includeLines }) });
  });

  route('POST', '/api/forms', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const kind = text(body(ctx).kind) as FormKind;
      if (!isFormKind(kind)) throw new Error('Tipo inválido');
      json(ctx.res, 200, { item: await createFormDocument(kind) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms/export', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const kind = text(ctx.query.get('kind'));
      if (!isFormKind(kind)) throw new Error('Informe kind=sale|purchase|product');
      sendWorkbook(ctx, await exportFormsByKind(kind));
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms/public/:token', async (ctx) => {
    json(ctx.res, 403, { error: 'Preenchimento público desativado. Faça login para enviar informações.' });
  });

  route('PUT', '/api/forms/public/:token', async (ctx) => {
    json(ctx.res, 403, { error: 'Preenchimento público desativado. Faça login para enviar informações.' });
  });

  route('GET', '/api/forms/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const item = await getFormDocument(ctx.params.id);
    if (!item) {
      json(ctx.res, 404, { error: 'Formulário não encontrado' });
      return;
    }
    json(ctx.res, 200, { item });
  });

  route('PUT', '/api/forms/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const current = await getFormDocument(ctx.params.id);
      if (!current) throw new Error('Formulário não encontrado');
      assertFormOrderEditable(current, 'editar');
      await saveFormDocument(ctx.params.id, parseSave(body(ctx)));
      const item = await markDocSyncPending(ctx.params.id);
      json(ctx.res, 200, { item, sync_status: 'syncing' });
      scheduleOdooPush(item.id);
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('DELETE', '/api/forms/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      const current = await getFormDocument(ctx.params.id);
      if (!current) throw new Error('Formulário não encontrado');
      assertFormOrderEditable(current, 'excluir');
      try {
        await cancelFormInOdoo(current);
      } catch (error) {
        console.error(
          `[odoo-auto-cancel] ${ctx.params.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
      await deleteFormDocument(ctx.params.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('GET', '/api/forms/:id/export', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      sendWorkbook(ctx, await exportFormById(ctx.params.id));
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/forms/:id/odoo-push', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      json(ctx.res, 200, { item: await pushFormToOdoo(ctx.params.id) });
    } catch (error) {
      fail(ctx, error);
    }
  });

  route('POST', '/api/forms/:id/public-link', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 403, { error: 'Link externo desativado. Apenas usuários logados podem enviar informações.' });
  });

  route('DELETE', '/api/forms/:id/public-link', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    try {
      json(ctx.res, 200, { item: await disablePublicLink(ctx.params.id) });
    } catch (error) {
      fail(ctx, error);
    }
  });
}
