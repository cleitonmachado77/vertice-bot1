import { api } from '../api.js';
import { escapeHtml, formatSyncError, toast, viewLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';
import { entityFromSlug, renderEntitiesBody } from './forms-entities.js';

const TABS = [
  { id: 'purchase', slug: 'compras', label: 'Compras' },
  { id: 'product', slug: 'inventario', label: 'Inventário' },
  { id: 'sale', slug: 'vendas', label: 'Vendas' },
  { id: 'cadastros', slug: 'cadastros', label: 'Cadastros' },
];

let schemaCache = null;
let catalogCache = { products: [], partners: [], refs: {}, at: 0 };

export function tabFromSlug(slug) {
  const raw = String(slug || '');
  if (
    raw === 'cadastros' ||
    raw.startsWith('cadastros/') ||
    raw === 'dados' ||
    raw.startsWith('dados/')
  ) {
    return 'cadastros';
  }
  return TABS.find((tab) => tab.slug === slug)?.id || 'product';
}

export function slugFromKind(kind) {
  return TABS.find((tab) => tab.id === kind)?.slug || 'inventario';
}

async function loadSchema() {
  const hasTrackSelect = schemaCache?.fields?.product?.header?.some(
    (field) => field.key === 'track_inventory' && field.options?.length,
  );
  if (schemaCache?.statuses && hasTrackSelect) return schemaCache;
  schemaCache = await api('/api/forms/schema');
  return schemaCache;
}

async function loadCatalog(force = false) {
  if (!force && catalogCache.at && Date.now() - catalogCache.at < 60_000) return catalogCache;
  const data = await api('/api/forms/catalog');
  catalogCache = {
    products: data.products || [],
    partners: data.partners || [],
    refs: data.refs || {},
    at: Date.now(),
  };
  return catalogCache;
}

function mainTabsHtml(activeKind) {
  return TABS.map((tab) => {
    const href = tab.id === 'cadastros' ? '#/forms/cadastros/produtos' : `#/forms/${tab.slug}`;
    return `<a class="settings-tab${tab.id === activeKind ? ' active' : ''}" href="${href}">${escapeHtml(tab.label)}</a>`;
  }).join('');
}

function topActions(kind) {
  if (kind === 'cadastros') {
    return `<button class="btn" type="button" data-new>Novo</button>`;
  }
  return `
    <button class="btn-ghost" type="button" data-export-all>Exportar Excel</button>
    <button class="btn" type="button" data-new>Novo registro</button>`;
}

function ensureFormsShell(root, kind) {
  let pane = root.querySelector('.forms-pane');
  if (!pane) {
    root.innerHTML = `
      <div class="view-pane forms-pane">
        <div class="forms-toolbar">
          <nav class="settings-tabs forms-tabs" id="forms-main-tabs" aria-label="Abas do Forms"></nav>
          <div class="row" id="forms-top-actions"></div>
        </div>
        <div id="forms-body" class="forms-body"></div>
      </div>`;
    pane = root.querySelector('.forms-pane');
  } else {
    root.querySelector('#forms-top')?.remove();
    root.querySelector('#odoo-status')?.remove();
    if (!root.querySelector('.forms-toolbar')) {
      const body = root.querySelector('#forms-body');
      const toolbar = document.createElement('div');
      toolbar.className = 'forms-toolbar';
      toolbar.innerHTML = `
        <nav class="settings-tabs forms-tabs" id="forms-main-tabs" aria-label="Abas do Forms"></nav>
        <div class="row" id="forms-top-actions"></div>`;
      pane.insertBefore(toolbar, body || pane.firstChild);
    }
  }
  const tabs = root.querySelector('#forms-main-tabs');
  if (tabs) tabs.innerHTML = mainTabsHtml(kind);
  const actions = root.querySelector('#forms-top-actions');
  if (actions) actions.innerHTML = topActions(kind);
  return root.querySelector('#forms-body');
}

export async function renderForms(root, kind = 'product', token = getNavToken(), options = {}) {
  const slug = options.slug || location.hash.replace('#/forms/', '');
  if (slug === 'dados' || slug.startsWith('dados/')) {
    location.replace(`#/forms/${slug.replace(/^dados/, 'cadastros') || 'cadastros/produtos'}`);
    return;
  }
  if (kind === 'cadastros' && (slug === 'cadastros' || slug === '')) {
    location.replace('#/forms/cadastros/produtos');
    return;
  }

  const soft = Boolean(options.soft && root.querySelector('.forms-pane'));
  if (!soft && !root.querySelector('.forms-pane')) {
    root.innerHTML = viewLoading('Abrindo Vertice Forms…');
  }

  const body = ensureFormsShell(root, kind);
  if (!body || !isNavActive(token)) return;

  body.classList.add('is-switching');
  body.innerHTML = `<p class="muted forms-body-loading">Carregando…</p>`;

  try {
    if (kind === 'cadastros') {
      await renderEntitiesBody(body, entityFromSlug(slug), token, root);
      bindShellActions(root, kind, null, null, [], token);
      return;
    }

    const [schema, catalog, data] = await Promise.all([
      loadSchema(),
      loadCatalog(false),
      api(`/api/forms?kind=${encodeURIComponent(kind)}`),
    ]);
    if (!isNavActive(token)) return;
    paintBody(body, kind, schema, catalog, data.items || [], null);
    bindShellActions(root, kind, schema, catalog, data.items || [], token);
    bindList(root, kind, schema, catalog, data.items || [], token);
  } finally {
    body.classList.remove('is-switching');
  }
}

function paintBody(body, kind, schema, catalog, items, editing) {
  const fields = schema.fields[kind];
  body.innerHTML = `
    ${catalogSummary(catalog)}
    <div class="forms-layout">
      <section class="card forms-list-card">
        <div class="card-head">
          <h2>Registros</h2>
          <p class="muted">${items.length} item(ns)</p>
        </div>
        <div class="forms-list" id="forms-list">
          ${
            items.length
              ? items.map((item) => listRow(item, editing?.id, schema, kind)).join('')
              : '<p class="muted">Nenhum registro ainda.</p>'
          }
        </div>
      </section>
      <section class="card forms-editor-card" id="forms-editor">
        ${editing ? editorHtml(editing, fields, kind, catalog, schema) : '<p class="muted">Selecione um registro ou crie um novo.</p>'}
      </section>
    </div>`;
}

function bindShellActions(root, kind, schema, catalog, items, token) {
  if (kind === 'cadastros') {
    root.querySelector('[data-new]')?.addEventListener('click', () => {
      root.querySelector('[data-entities-new]')?.click();
    });
    return;
  }

  root.querySelector('[data-new]')?.addEventListener('click', async () => {
    try {
      const created = await api('/api/forms', { method: 'POST', body: { kind } });
      toast('Registro criado');
      await refresh(root, kind, schema, created.item?.id, token);
    } catch (error) {
      toast(error.message);
    }
  });

  root.querySelector('[data-export-all]')?.addEventListener('click', async () => {
    try {
      await download(`/api/forms/export?kind=${encodeURIComponent(kind)}`);
      toast('Planilha gerada');
    } catch (error) {
      toast(error.message);
    }
  });
}

function paint(root, kind, schema, catalog, items, editing, token) {
  const body = ensureFormsShell(root, kind);
  paintBody(body, kind, schema, catalog, items, editing);
  bindShellActions(root, kind, schema, catalog, items, token);
  bindList(root, kind, schema, catalog, items, token);
}

function catalogSummary(catalog) {
  const products = catalog.products?.length || 0;
  const customers = (catalog.partners || []).filter((p) => p.is_customer).length;
  const vendors = (catalog.partners || []).filter((p) => p.is_vendor).length;
  return `
    <div class="forms-catalog-bar muted">
      Catálogo: <strong>${products}</strong> produtos ·
      <strong>${customers}</strong> clientes ·
      <strong>${vendors}</strong> fornecedores
    </div>`;
}

function statusOptions(schema, kind) {
  return schema?.statuses?.[kind] || [];
}

function statusLabel(schema, kind, status) {
  const value = String(status || 'draft');
  const found = statusOptions(schema, kind).find((item) => item.value === value);
  if (found) return found.label;
  if (value === 'ready') return 'Cotação';
  if (value === 'exported') return kind === 'sale' ? 'Pedido de venda' : kind === 'purchase' ? 'Pedido de compra' : value;
  return value;
}

/** Pedidos confirmados no Odoo não podem ser editados/excluídos no Vertice. */
function isOrderLocked(doc, kind) {
  if (kind !== 'sale' && kind !== 'purchase') return false;
  const state = String(doc?.header?.odoo_state || doc?.status || 'draft').toLowerCase();
  return Boolean(state) && state !== 'draft' && state !== 'sent' && state !== 'to approve';
}

function syncBadgeHtml(doc) {
  const header = doc?.header || {};
  const pending = header.odoo_sync_pending === '1';
  const error = formatSyncError(header.odoo_sync_error || '', 420);
  const rawError = String(header.odoo_sync_error || '').trim();
  const odooId = header.odoo_id || '';
  const ref = header.order_reference || '';
  const when = header.odoo_synced_at
    ? ` · ${new Date(header.odoo_synced_at).toLocaleString('pt-BR')}`
    : '';
  if (pending) {
    return `<div class="forms-sync-notice is-pending" data-sync-badge role="status">
      <span class="forms-sync-msg">Odoo · sincronizando…</span>
    </div>`;
  }
  if (rawError) {
    return `<div class="forms-sync-notice is-error" data-sync-badge role="alert" title="${escapeHtml(rawError)}">
      <span class="forms-sync-msg"><strong>Odoo · não sincronizado.</strong> ${escapeHtml(error)}</span>
      <button class="btn-ghost" type="button" data-odoo-retry>Tentar novamente</button>
    </div>`;
  }
  if (odooId || ref) {
    return `<div class="forms-sync-notice" data-sync-badge role="status">
      <span class="forms-sync-msg">Odoo · sincronizado${
        ref ? ` · ${escapeHtml(ref)}` : ''
      }${odooId ? ` #${escapeHtml(odooId)}` : ''}${escapeHtml(when)}</span>
    </div>`;
  }
  return `<div class="forms-sync-notice is-pending" data-sync-badge role="status">
    <span class="forms-sync-msg">Odoo · ainda não sincronizado</span>
  </div>`;
}

async function pollSyncStatus(root, kind, schema, docId, token, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (!isNavActive(token)) return;
    try {
      const detail = await api(`/api/forms/${encodeURIComponent(docId)}`);
      const item = detail.item;
      if (!item) return;
      const pending = item.header?.odoo_sync_pending === '1';
      if (!pending) {
        const err = String(item.header?.odoo_sync_error || '').trim();
        if (err) {
          toast(`Odoo: ${formatSyncError(err, 220)}`, { tone: 'error' });
        } else if (item.header?.order_reference || item.header?.odoo_id) {
          const label = item.header.order_reference || `#${item.header.odoo_id}`;
          toast(`Sincronizado com Odoo · ${label}`, { tone: 'subtle' });
        }
        await refresh(root, kind, schema, docId, token);
        return;
      }
    } catch {
      return;
    }
  }
  if (isNavActive(token)) {
    try {
      const detail = await api(`/api/forms/${encodeURIComponent(docId)}`);
      const err = String(detail.item?.header?.odoo_sync_error || '').trim();
      if (err) toast(`Odoo: ${formatSyncError(err, 220)}`, { tone: 'error' });
      else if (detail.item?.header?.odoo_sync_pending === '1') {
        toast('Odoo ainda sincronizando — abra o registro em instantes', { tone: 'subtle' });
      }
    } catch {
      /* ignore */
    }
    await refresh(root, kind, schema, docId, token);
  }
}

function listRow(item, activeId, schema, kind) {
  const when = item.updated_at ? new Date(item.updated_at).toLocaleString('pt-BR') : '';
  let odoo = '';
  if (item.header?.odoo_sync_pending === '1') odoo = ' · sync…';
  else if (item.header?.odoo_sync_error) {
    odoo = ` · ${formatSyncError(item.header.odoo_sync_error, 72)}`;
  } else if (item.header?.order_reference) odoo = ` · ${item.header.order_reference}`;
  else if (item.header?.odoo_id) odoo = ` · Odoo #${item.header.odoo_id}`;
  const locked = isOrderLocked(item, kind) ? ' · bloqueado' : '';
  const statusText =
    kind === 'product' ? '' : `${escapeHtml(statusLabel(schema, kind, item.status))} · `;
  return `
    <button class="forms-list-item${item.id === activeId ? ' active' : ''}" type="button" data-open="${escapeHtml(item.id)}">
      <strong>${escapeHtml(item.title || 'Sem título')}</strong>
      <span>${statusText}${escapeHtml(when)}${escapeHtml(odoo)}${escapeHtml(locked)}</span>
    </button>`;
}

function editorHtml(doc, fields, kind, catalog, schema) {
  const hasLines = (fields.lines || []).length > 0;
  const publicUrl = doc.public_enabled && doc.public_token ? `${location.origin}/forms/p/${doc.public_token}` : '';
  const statuses = statusOptions(schema, kind);
  const currentStatus = String(doc.header?.odoo_state || doc.status || 'draft');
  const locked = isOrderLocked(doc, kind);
  const lockAttr = locked ? ' disabled' : '';
  const statusSelect =
    statuses.length === 0
      ? ''
      : `<label>Status
        <select name="status"${lockAttr}>
          ${statuses
            .map(
              (item) =>
                `<option value="${escapeHtml(item.value)}"${
                  currentStatus === item.value ||
                  (currentStatus === 'ready' && item.value === 'draft') ||
                  (currentStatus === 'exported' &&
                    ((kind === 'sale' && item.value === 'sale') ||
                      (kind === 'purchase' && item.value === 'purchase')))
                    ? ' selected'
                    : ''
                }>${escapeHtml(item.label)}</option>`,
            )
            .join('')}
        </select>
      </label>`;
  return `
    <form id="forms-form" data-id="${escapeHtml(doc.id)}" data-kind="${escapeHtml(kind)}"${
      locked ? ' data-locked="1"' : ''
    }>
      <div class="card-head forms-editor-head">
        <div>
          <h2>Editar registro</h2>
          <p class="muted">${
            locked
              ? 'Pedido confirmado no Odoo — edição e exclusão bloqueadas no Vertice.'
              : 'Salvar envia automaticamente ao Odoo. Sugestões vêm do catálogo compartilhado.'
          }</p>
        </div>
        <div class="row">
          <button class="btn-danger" type="button" data-delete${lockAttr}>Excluir</button>
        </div>
      </div>
      ${syncBadgeHtml(doc)}
      <label>Título
        <input name="title" value="${escapeHtml(doc.title || '')}"${lockAttr} />
      </label>
      ${statusSelect}
      <div class="forms-section">
        <h2>Dados principais</h2>
        <div class="grid-2">
          ${(fields.header || []).map((field) => headerInput(field, doc.header?.[field.key] || '', kind)).join('')}
        </div>
      </div>
      ${
        hasLines
          ? `<div class="forms-section">
              <div class="row forms-lines-head">
                <h2>Linhas de produto</h2>
                ${
                  locked
                    ? ''
                    : '<button class="btn-ghost" type="button" data-add-line>Adicionar linha</button>'
                }
              </div>
              <div id="forms-lines">${(doc.lines || []).map((line, index) => lineHtml(line, fields.lines, index, kind)).join('')}</div>
            </div>`
          : ''
      }
      <div class="forms-section">
        <h2>Link externo</h2>
        <p class="muted">Permite preenchimento sem login (com o mesmo catálogo).</p>
        ${
          publicUrl
            ? `<div class="forms-link-box">
                <input readonly value="${escapeHtml(publicUrl)}" id="public-link-input" />
                <button class="btn-ghost" type="button" data-copy-link>Copiar</button>
                <button class="btn-ghost" type="button" data-disable-link${lockAttr}>Desativar</button>
              </div>`
            : `<button class="btn-ghost" type="button" data-enable-link${lockAttr}>Gerar link público</button>`
        }
      </div>
      <div class="row forms-actions">
        <button class="btn" type="submit"${lockAttr}>Salvar</button>
      </div>
    </form>`;
}

function catalogComboField(field, value, options = {}) {
  const nameAttr = options.name ? ` name="${escapeHtml(options.name)}"` : '';
  const lineKey = options.lineKey ? ` data-line-key="${escapeHtml(options.lineKey)}"` : '';
  const multi = field.catalogMulti ? '1' : '0';
  const taxKind = field.catalog === 'tax' && options.kind ? ` data-tax-kind="${escapeHtml(options.kind)}"` : '';
  const readonly = field.readonly ? ' readonly' : '';
  return `
    <label class="forms-combo-label">${escapeHtml(field.label)}${field.required ? ' *' : ''}
      <div class="forms-combo" data-ref-combo="${escapeHtml(field.catalog)}" data-ref-multi="${multi}"${taxKind}>
        <input
          ${nameAttr}${lineKey}
          value="${escapeHtml(value)}"
          placeholder="${escapeHtml(field.placeholder || 'Buscar…')}"
          autocomplete="off"
          spellcheck="false"
          data-combo-input
          ${readonly}
        />
        <div class="forms-combo-menu" data-combo-menu hidden role="listbox"></div>
      </div>
    </label>`;
}

function headerInput(field, value, kind) {
  const readonly = field.readonly ? ' readonly' : '';
  const isPartner =
    (field.key === 'customer' && kind === 'sale') || (field.key === 'vendor' && kind === 'purchase');
  if (isPartner) {
    const role = field.key === 'customer' ? 'customer' : 'vendor';
    const placeholder =
      field.placeholder || (role === 'vendor' ? 'Buscar fornecedor…' : 'Buscar cliente…');
    return `
    <label class="forms-combo-label">${escapeHtml(field.label)}${field.required ? ' *' : ''}
      <div class="forms-combo" data-partner-combo="${role}">
        <input
          name="h_${escapeHtml(field.key)}"
          value="${escapeHtml(value)}"
          placeholder="${escapeHtml(placeholder)}"
          autocomplete="off"
          spellcheck="false"
          data-combo-input
        />
        <div class="forms-combo-menu" data-combo-menu hidden role="listbox"></div>
      </div>
    </label>`;
  }
  if (field.key === 'name' && kind === 'product') {
    return `
    <label class="forms-combo-label">${escapeHtml(field.label)}${field.required ? ' *' : ''}
      <div class="forms-combo" data-product-combo="header">
        <input
          name="h_${escapeHtml(field.key)}"
          value="${escapeHtml(value)}"
          placeholder="${escapeHtml(field.placeholder || 'Buscar produto…')}"
          autocomplete="off"
          spellcheck="false"
          data-combo-input
        />
        <div class="forms-combo-menu" data-combo-menu hidden role="listbox"></div>
      </div>
    </label>`;
  }
  if (field.catalog) {
    return catalogComboField(field, value, { name: `h_${field.key}`, kind });
  }
  if (field.options?.length) {
    const current = String(value || field.options[0]?.value || '');
    return `
    <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}
      <select name="h_${escapeHtml(field.key)}">
        ${field.options
          .map(
            (opt) =>
              `<option value="${escapeHtml(opt.value)}"${opt.value === current ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`,
          )
          .join('')}
      </select>
    </label>`;
  }
  const displayValue = field.date ? toDisplayDate(value) : value;
  const dateAttrs = field.date
    ? ' inputmode="numeric" autocomplete="off" data-date-br="1" maxlength="10"'
    : '';
  return `
    <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}
      <input name="h_${escapeHtml(field.key)}" value="${escapeHtml(displayValue)}" placeholder="${escapeHtml(field.placeholder || '')}"${readonly}${dateAttrs} />
    </label>`;
}

/** Odoo/ISO → dd/mm/aaaa para exibição. */
function toDisplayDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return raw;
  return raw;
}

/** dd/mm/aaaa (ou ISO) → AAAA-MM-DD para Odoo. */
function toIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) {
    const day = br[1].padStart(2, '0');
    const month = br[2].padStart(2, '0');
    return `${br[3]}-${month}-${day}`;
  }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return raw;
}

function bindDateInputs(form) {
  form.querySelectorAll('[data-date-br]').forEach((input) => {
    if (input.dataset.boundDate === '1') return;
    input.dataset.boundDate = '1';
    input.addEventListener('input', () => {
      const digits = String(input.value || '')
        .replace(/\D/g, '')
        .slice(0, 8);
      let next = digits;
      if (digits.length > 4) next = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
      else if (digits.length > 2) next = `${digits.slice(0, 2)}/${digits.slice(2)}`;
      if (next !== input.value) input.value = next;
    });
  });
}

function lineHtml(line, lineFields, index, kind) {
  return `
    <div class="forms-line" data-line-id="${escapeHtml(line.id || '')}">
      <div class="forms-line-top">
        <strong>Item ${index + 1}</strong>
        <button class="btn-ghost" type="button" data-remove-line>Remover</button>
      </div>
      <div class="grid-2">
        ${lineFields
          .map((field) => {
            if (field.key === 'product') {
              return `
          <label class="forms-combo-label">${escapeHtml(field.label)}${field.required ? ' *' : ''}
            <div class="forms-combo" data-product-combo="line" data-price-kind="${escapeHtml(kind)}">
              <input
                data-line-key="product"
                data-product-input="1"
                data-price-kind="${escapeHtml(kind)}"
                data-combo-input
                value="${escapeHtml(line.values?.[field.key] || '')}"
                placeholder="Buscar produto…"
                autocomplete="off"
                spellcheck="false"
              />
              <div class="forms-combo-menu" data-combo-menu hidden role="listbox"></div>
            </div>
          </label>`;
            }
            if (field.catalog) {
              return catalogComboField(field, line.values?.[field.key] || '', {
                lineKey: field.key,
                kind,
              });
            }
            return `
          <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}
            <input data-line-key="${escapeHtml(field.key)}" value="${escapeHtml(line.values?.[field.key] || '')}" />
          </label>`;
          })
          .join('')}
      </div>
    </div>`;
}

function partnerMeta(partner) {
  const bits = [];
  if (partner.odoo_id) bits.push(`Odoo #${partner.odoo_id}`);
  if (partner.is_customer && partner.is_vendor) bits.push('Cliente e fornecedor');
  else if (partner.is_vendor) bits.push('Fornecedor');
  else if (partner.is_customer) bits.push('Cliente');
  return bits.join(' · ');
}

function productMeta(product) {
  const bits = [];
  if (product.internal_ref) bits.push(product.internal_ref);
  if (product.uom) bits.push(product.uom);
  if (product.sales_price) bits.push(`venda ${product.sales_price}`);
  if (product.cost) bits.push(`custo ${product.cost}`);
  if (product.qty_on_hand) bits.push(`estoque ${product.qty_on_hand}`);
  return bits.join(' · ');
}

function refMeta(item, refType) {
  const bits = [];
  if (item.odoo_id) bits.push(`Odoo #${item.odoo_id}`);
  if (refType === 'tax') {
    if (item.meta?.type_tax_use) bits.push(item.meta.type_tax_use);
    if (item.meta?.amount) bits.push(`${item.meta.amount}%`);
    if (item.meta?.company_id) bits.push(`emp. ${item.meta.company_id}`);
    if (item.meta?.country_id) bits.push(`país ${item.meta.country_id}`);
  }
  if (refType === 'category' && item.meta?.short_name && item.meta.short_name !== item.name) {
    bits.push(item.meta.short_name);
  }
  return bits.join(' · ');
}

function appendMultiValue(current, next) {
  const parts = String(current || '')
    .split(/[,;|/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === next.toLowerCase())) parts.push(next);
  return parts.join(', ');
}

function bindCatalogCombos(form, catalog) {
  const refs = catalog.refs || {};
  form.querySelectorAll('[data-ref-combo]').forEach((wrap) => {
    if (wrap.dataset.boundCombo === '1') return;
    const refType = wrap.getAttribute('data-ref-combo');
    const multi = wrap.getAttribute('data-ref-multi') === '1';
    const taxKind = wrap.getAttribute('data-tax-kind');
    let items = refs[refType] || [];
    if (refType === 'tax' && taxKind) {
      const want = taxKind === 'purchase' ? 'purchase' : 'sale';
      const filtered = items.filter((item) => {
        const use = String(item.meta?.type_tax_use || '');
        return !use || use === want || use === 'all';
      });
      if (filtered.length) items = filtered;
    }
    if (multi) {
      const input = wrap.querySelector('[data-combo-input]');
      input?.addEventListener('focus', () => {
        input.dataset.comboBefore = input.value || '';
      });
    }
    bindTextCombo(wrap, {
      items,
      getMeta: (item) => refMeta(item, refType),
      emptyLabel: 'Nenhum cadastro Odoo encontrado (Receber dados)',
      onPick: (input) => {
        if (!multi) return;
        const picked = input.value;
        const before = input.dataset.comboBefore || '';
        input.value = appendMultiValue(before, picked);
        delete input.dataset.comboBefore;
      },
    });
  });
}

function bindTextCombo(wrap, options) {
  if (wrap.dataset.boundCombo === '1') return;
  wrap.dataset.boundCombo = '1';
  const input = wrap.querySelector('[data-combo-input]');
  const menu = wrap.querySelector('[data-combo-menu]');
  if (!input || !menu) return;

  const pool = options.items || [];
  let activeIndex = -1;

  const close = () => {
    menu.hidden = true;
    menu.innerHTML = '';
    activeIndex = -1;
    wrap.classList.remove('is-open');
  };

  const pick = (value) => {
    input.value = value || '';
    options.onPick?.(input);
    close();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const paint = (query) => {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    const matches = (
      q ? pool.filter((item) => String(item.name || '').toLowerCase().includes(q)) : pool
    ).slice(0, 12);
    if (!matches.length) {
      menu.innerHTML = `<div class="forms-combo-empty">${escapeHtml(options.emptyLabel || 'Nenhum resultado')}</div>`;
      menu.hidden = false;
      wrap.classList.add('is-open');
      activeIndex = -1;
      return;
    }
    menu.innerHTML = matches
      .map((item, index) => {
        const meta = options.getMeta?.(item) || '';
        return `<button type="button" class="forms-combo-option${
          index === activeIndex ? ' is-active' : ''
        }" data-combo-pick="${escapeHtml(item.name)}" role="option">
            <strong>${escapeHtml(item.name)}</strong>
            ${meta ? `<span>${escapeHtml(meta)}</span>` : ''}
          </button>`;
      })
      .join('');
    menu.hidden = false;
    wrap.classList.add('is-open');
    menu.querySelectorAll('[data-combo-pick]').forEach((btn) => {
      btn.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(btn.getAttribute('data-combo-pick') || '');
      });
    });
  };

  input.addEventListener('focus', () => paint(input.value));
  input.addEventListener('input', () => paint(input.value));
  input.addEventListener('keydown', (event) => {
    if (menu.hidden) {
      if (event.key === 'ArrowDown') paint(input.value);
      return;
    }
    const optionEls = [...menu.querySelectorAll('.forms-combo-option')];
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(optionEls.length - 1, activeIndex + 1);
      optionEls.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
      optionEls[activeIndex]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(0, activeIndex - 1);
      optionEls.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
      optionEls[activeIndex]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0 && optionEls[activeIndex]) {
      event.preventDefault();
      pick(optionEls[activeIndex].getAttribute('data-combo-pick') || '');
    }
  });
  input.addEventListener('blur', () => {
    window.setTimeout(close, 120);
  });
}

function bindPartnerCombos(form, catalog) {
  const partners = catalog.partners || [];
  form.querySelectorAll('[data-partner-combo]').forEach((wrap) => {
    const role = wrap.getAttribute('data-partner-combo');
    const pool = partners.filter((p) => (role === 'vendor' ? p.is_vendor : p.is_customer));
    bindTextCombo(wrap, {
      items: pool,
      getMeta: partnerMeta,
      emptyLabel: `Nenhum ${role === 'vendor' ? 'fornecedor' : 'cliente'} encontrado`,
    });
  });
}

function applyProductPrice(input, catalog) {
  const products = catalog.products || [];
  const match = products.find(
    (item) => item.name.trim().toLowerCase() === String(input.value || '').trim().toLowerCase(),
  );
  if (!match) return;
  const line = input.closest('.forms-line');
  const price = line?.querySelector('[data-line-key="unit_price"]');
  if (!price || price.value.trim()) return;
  const kind = input.getAttribute('data-price-kind');
  price.value =
    kind === 'purchase' ? match.cost || match.sales_price || '' : match.sales_price || match.cost || '';
}

function bindProductCombos(form, catalog) {
  form.querySelectorAll('[data-product-combo]').forEach((wrap) => {
    bindTextCombo(wrap, {
      items: catalog.products || [],
      getMeta: productMeta,
      emptyLabel: 'Nenhum produto encontrado',
      onPick: (input) => applyProductPrice(input, catalog),
    });
  });
}

function bindList(root, kind, schema, catalog, items, token) {
  root.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-open');
      try {
        const detail = await api(`/api/forms/${encodeURIComponent(id)}`);
        const found = detail.item;
        if (!found) return;
        const nextItems = items.map((item) => (item.id === found.id ? found : item));
        const body = root.querySelector('#forms-body');
        paintBody(body, kind, schema, catalog, nextItems, found);
        bindList(root, kind, schema, catalog, nextItems, token);
        bindEditor(root, kind, schema, catalog, nextItems, found, token);
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function bindEditor(root, kind, schema, catalog, items, doc, token) {
  const form = root.querySelector('#forms-form');
  if (!form) return;
  const fields = schema.fields[kind];
  const locked = form.dataset.locked === '1' || isOrderLocked(doc, kind);
  bindPartnerCombos(form, catalog);
  bindProductCombos(form, catalog);
  bindCatalogCombos(form, catalog);
  bindDateInputs(form);
  bindProductAutofill(form, catalog);
  bindLineRemoves(form, catalog);

  if (locked) {
    form
      .querySelectorAll(
        'input:not([id="public-link-input"]), select, textarea, button[type="submit"], [data-delete], [data-add-line], [data-remove-line], [data-enable-link], [data-disable-link], [data-odoo-retry]',
      )
      .forEach((el) => {
        el.disabled = true;
      });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (locked) {
      toast('Pedido confirmado no Odoo; edição bloqueada');
      return;
    }
    try {
      const payload = collectPayload(form, fields);
      await api(`/api/forms/${doc.id}`, { method: 'PUT', body: payload });
      toast('Salvo · sincronizando com Odoo…');
      await refresh(root, kind, schema, doc.id, token);
      void pollSyncStatus(root, kind, schema, doc.id, token);
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });

  form.querySelector('[data-odoo-retry]')?.addEventListener('click', async () => {
    try {
      await api(`/api/forms/${doc.id}/odoo-push`, { method: 'POST', body: {} });
      toast('Reenviado ao Odoo', { tone: 'subtle' });
      await refresh(root, kind, schema, doc.id, token);
      void pollSyncStatus(root, kind, schema, doc.id, token);
    } catch (error) {
      toast(`Odoo: ${formatSyncError(error.message || error)}`, { tone: 'error' });
      await refresh(root, kind, schema, doc.id, token);
    }
  });

  form.querySelector('[data-add-line]')?.addEventListener('click', () => {
    if (locked) return;
    const box = form.querySelector('#forms-lines');
    if (!box) return;
    const index = box.querySelectorAll('.forms-line').length;
    box.insertAdjacentHTML('beforeend', lineHtml({ id: '', values: {} }, fields.lines, index, kind));
    bindLineRemoves(form, catalog);
    bindProductCombos(form, catalog);
    bindCatalogCombos(form, catalog);
    bindProductAutofill(form, catalog);
  });

  form.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (locked) {
      toast('Pedido confirmado no Odoo; exclusão bloqueada');
      return;
    }
    if (!confirm('Excluir este registro? O pedido correspondente será cancelado no Odoo.')) return;
    try {
      await api(`/api/forms/${doc.id}`, { method: 'DELETE' });
      toast('Excluído · cancelado no Odoo', { tone: 'subtle' });
      await refresh(root, kind, schema, null, token);
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });

  form.querySelector('[data-enable-link]')?.addEventListener('click', async () => {
    try {
      const result = await api(`/api/forms/${doc.id}/public-link`, { method: 'POST', body: {} });
      const url = result.url?.startsWith('http') ? result.url : `${location.origin}${result.url}`;
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast('Link gerado');
      await refresh(root, kind, schema, doc.id, token);
    } catch (error) {
      toast(error.message);
    }
  });

  form.querySelector('[data-disable-link]')?.addEventListener('click', async () => {
    try {
      await api(`/api/forms/${doc.id}/public-link`, { method: 'DELETE' });
      toast('Link desativado');
      await refresh(root, kind, schema, doc.id, token);
    } catch (error) {
      toast(error.message);
    }
  });

  form.querySelector('[data-copy-link]')?.addEventListener('click', async () => {
    const input = form.querySelector('#public-link-input');
    if (!input) return;
    await navigator.clipboard?.writeText(input.value).catch(() => {});
    toast('Link copiado');
  });
}

function bindProductAutofill(form, catalog) {
  form.querySelectorAll('[data-product-input]').forEach((input) => {
    if (input.dataset.boundCatalog === '1') return;
    input.dataset.boundCatalog = '1';
    input.addEventListener('change', () => applyProductPrice(input, catalog));
  });
}

function bindLineRemoves(form, catalog) {
  form.querySelectorAll('[data-remove-line]').forEach((button) => {
    button.onclick = () => button.closest('.forms-line')?.remove();
  });
  bindProductCombos(form, catalog);
  bindCatalogCombos(form, catalog);
  bindProductAutofill(form, catalog);
}

function collectPayload(form, fields) {
  const data = new FormData(form);
  const header = {};
  for (const field of fields.header || []) {
    const raw = String(data.get(`h_${field.key}`) || '');
    header[field.key] = field.date ? toIsoDate(raw) : raw;
  }
  const lines = [...form.querySelectorAll('.forms-line')].map((node) => {
    const values = {};
    node.querySelectorAll('[data-line-key]').forEach((input) => {
      values[input.getAttribute('data-line-key')] = input.value || '';
    });
    return {
      id: node.getAttribute('data-line-id') || undefined,
      values,
    };
  });
  return {
    title: String(data.get('title') || ''),
    status: String(data.get('status') || 'draft'),
    header,
    lines: (fields.lines || []).length ? lines : undefined,
  };
}

async function refresh(root, kind, schema, openId, token) {
  const [catalog, data] = await Promise.all([
    loadCatalog(false),
    api(`/api/forms?kind=${encodeURIComponent(kind)}`),
  ]);
  if (!isNavActive(token)) return;
  let items = data.items || [];
  let editing = null;
  if (openId) {
    try {
      const detail = await api(`/api/forms/${encodeURIComponent(openId)}`);
      editing = detail.item || null;
      if (editing) items = items.map((item) => (item.id === editing.id ? editing : item));
    } catch {
      editing = items.find((item) => item.id === openId) || null;
    }
  }
  const body = ensureFormsShell(root, kind);
  paintBody(body, kind, schema, catalog, items, editing);
  bindShellActions(root, kind, schema, catalog, items, token);
  bindList(root, kind, schema, catalog, items, token);
  if (editing) bindEditor(root, kind, schema, catalog, items, editing, token);
}

async function download(path) {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Falha ao exportar');
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] || 'vertice-forms.xlsx';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
