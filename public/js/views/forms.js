import { api } from '../api.js';
import { odooLabelPt } from '../odoo-pt.js';
import { createPoll, escapeHtml, formatSyncError, toast, viewLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';
import { entityFromSlug, renderEntitiesBody } from './forms-entities.js';
import {
  closeEditorModal,
  ensureFormsModal,
  getFormsEditor,
  openEditorModal,
} from './forms-modal.js';
import {
  collectPresetVisible,
  draftFromPreset,
  loadPresets,
  normalizePresetVisible,
  openPresetsManager,
  presetsToolbarHtml,
} from './forms-presets.js';

const TABS = [
  { id: 'purchase', slug: 'compras', label: 'Compras' },
  { id: 'product', slug: 'inventario', label: 'Inventário' },
  { id: 'production', slug: 'fabricacao', label: 'Fabricação' },
  { id: 'sale', slug: 'vendas', label: 'Vendas' },
  { id: 'cadastros', slug: 'cadastros', label: 'Cadastros' },
];

let schemaCache = null;
let catalogCache = { products: [], partners: [], refs: {}, at: 0 };
/** Filtros da lista de registros (persistem entre refreshes da mesma aba). */
let listFilters = { q: '', partner: '', date: '', kind: '' };
/** Itens da lista atual — soft refresh atualiza sem remontar o shell (evita piscar). */
let listSession = { kind: '', items: [], schema: null, catalog: null, token: null };
/** Poll da lista enquanto a aba Forms (compras/vendas/inventário) está aberta. */
let stopListPoll = null;

function rememberListSession(kind, schema, catalog, items, token) {
  listSession = { kind, schema, catalog, items: items || [], token };
}

function stopFormsListPoll() {
  if (stopListPoll) {
    stopListPoll();
    stopListPoll = null;
  }
}

function listFingerprint(items) {
  return (items || [])
    .map((item) => {
      const lines = Array.isArray(item.lines)
        ? item.lines
            .map((line) => `${line.values?.product || ''}:${line.values?.quantity || ''}`)
            .join(';')
        : '';
      return `${item.id}|${item.updated_at || ''}|${item.status || ''}|${lines}`;
    })
    .join('\n');
}

function startFormsListPoll(root, kind, schema, token) {
  stopFormsListPoll();
  if (kind === 'cadastros') return;
  stopListPoll = createPoll(async () => {
    if (!isNavActive(token) || !root.querySelector('#forms-list')) {
      stopFormsListPoll();
      return;
    }
    const sess = listSession;
    const activeSchema = sess.schema || schema;
    const activeKind = sess.kind || kind;
    if (!activeSchema || activeKind === 'cadastros') return;
    await refreshListQuiet(root, activeKind, activeSchema, sess.token || token, {
      keepEditor: true,
    });
  }, 4000);
}

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
  if (raw === 'prensagem') return 'production';
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

function topActions(kind, presets = []) {
  if (kind === 'cadastros') {
    return `<button class="btn" type="button" data-new>Novo</button>`;
  }
  return `
    ${presetsToolbarHtml(presets)}
    <button class="btn-ghost" type="button" data-export-all>Exportar Excel</button>
    <button class="btn" type="button" data-new>Novo registro</button>`;
}

function ensureFormsShell(root, kind, presets = []) {
  let pane = root.querySelector('.forms-pane');
  if (!pane) {
    root.innerHTML = `
      <div class="view-pane forms-pane">
        <div class="forms-toolbar">
          <nav class="settings-tabs forms-tabs" id="forms-main-tabs" aria-label="Abas do Forms"></nav>
          <div class="row forms-top-actions" id="forms-top-actions"></div>
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
        <div class="row forms-top-actions" id="forms-top-actions"></div>`;
      pane.insertBefore(toolbar, body || pane.firstChild);
    }
  }
  const tabs = root.querySelector('#forms-main-tabs');
  if (tabs) tabs.innerHTML = mainTabsHtml(kind);
  const actions = root.querySelector('#forms-top-actions');
  if (actions) {
    actions.classList.add('forms-top-actions');
    actions.innerHTML = topActions(kind, presets);
  }
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

  stopFormsListPoll();

  const soft = Boolean(options.soft && root.querySelector('.forms-pane'));
  if (!soft && !root.querySelector('.forms-pane')) {
    root.innerHTML = viewLoading('Abrindo Vertice Forms…');
  }

  const body = ensureFormsShell(root, kind, []);
  if (!body || !isNavActive(token)) return;

  document.body.classList.remove('forms-modal-open');
  body.classList.add('is-switching');
  body.innerHTML = `<p class="muted forms-body-loading">Carregando…</p>`;

  try {
    if (kind === 'cadastros') {
      await renderEntitiesBody(body, entityFromSlug(slug), token, root);
      bindShellActions(root, kind, null, null, [], token, []);
      return;
    }

    const [schema, catalog, data, presets] = await Promise.all([
      loadSchema(),
      loadCatalog(false),
      api(`/api/forms?kind=${encodeURIComponent(kind)}&lines=1`),
      loadPresets(kind).catch(() => []),
    ]);
    if (!isNavActive(token)) return;
    ensureFormsShell(root, kind, presets);
    rememberListSession(kind, schema, catalog, data.items || [], token);
    paintBody(body, kind, schema, catalog, data.items || [], null);
    bindShellActions(root, kind, schema, catalog, data.items || [], token, presets);
    bindFilters(root, kind, schema, catalog, data.items || [], token);
    bindList(root, kind, schema, catalog, data.items || [], token);
    startFormsListPoll(root, kind, schema, token);
  } finally {
    body.classList.remove('is-switching');
  }
}

function paintBody(body, kind, schema, catalog, items, editing) {
  // Remove modal portaled para o body em aberturas anteriores (evita IDs duplicados).
  document.querySelectorAll('body > #forms-modal').forEach((el) => el.remove());
  document.body.classList.remove('forms-modal-open');
  if (listFilters.kind !== kind) {
    listFilters = { q: '', partner: '', date: '', kind };
  }
  const filtered = filterItems(items, schema, kind, listFilters);
  const filterCfg = listFilterConfig(kind);
  const partnerOpts = partnerFilterOptions(items, kind);
  const countLabel =
    filtered.length === items.length
      ? `${items.length} item(ns)`
      : `${filtered.length} de ${items.length} item(ns)`;
  body.innerHTML = `
    ${catalogSummary(catalog)}
    <div class="forms-layout">
      <section class="card forms-list-card">
        <div class="card-head forms-list-head">
          <div>
            <h2>Registros</h2>
            <p class="muted" id="forms-list-count">${escapeHtml(countLabel)}</p>
          </div>
        </div>
        <div class="forms-filters" id="forms-filters">
          <label class="forms-filter-search">
            <span class="sr-only">Buscar</span>
            <input
              type="search"
              id="forms-filter-q"
              placeholder="${escapeHtml(filterCfg.searchPlaceholder)}"
              value="${escapeHtml(listFilters.q)}"
              autocomplete="off"
            />
          </label>
          ${
            filterCfg.selectLabel
              ? `<label class="forms-filter-partner">
                  <span class="sr-only">${escapeHtml(filterCfg.selectLabel)}</span>
                  <select id="forms-filter-partner">
                    <option value="">${escapeHtml(filterCfg.selectAll)}</option>
                    ${partnerOpts
                      .map(
                        (name) =>
                          `<option value="${escapeHtml(name)}"${
                            listFilters.partner === name ? ' selected' : ''
                          }>${escapeHtml(name)}</option>`,
                      )
                      .join('')}
                  </select>
                </label>
                <label class="forms-filter-date">
                  <span class="sr-only">Data</span>
                  <input
                    type="text"
                    id="forms-filter-date"
                    placeholder="dd/mm/aaaa"
                    inputmode="numeric"
                    autocomplete="off"
                    data-date-br="1"
                    maxlength="10"
                    value="${escapeHtml(toDisplayDate(listFilters.date || ''))}"
                  />
                </label>`
              : ''
          }
        </div>
        <div class="forms-list" id="forms-list">
          ${listRowsHtml(filtered, editing?.id, schema, kind, items.length)}
        </div>
      </section>
    </div>
    <div class="forms-modal${editing ? ' is-open' : ''}" id="forms-modal" ${editing ? '' : 'hidden'}>
      <div class="forms-modal-backdrop" data-close-modal tabindex="-1"></div>
      <section
        class="card forms-editor-card forms-modal-dialog"
        id="forms-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="forms-editor-title"
      >
        ${
          editing
            ? editorHtml(editing, schema.fields[kind], kind, catalog, schema)
            : ''
        }
      </section>
    </div>`;
}

function listRowsHtml(filtered, activeId, schema, kind, totalCount) {
  if (!filtered.length) {
    if (totalCount === 0) return '<p class="muted">Nenhum registro ainda.</p>';
    return '<p class="muted">Nenhum registro corresponde aos filtros.</p>';
  }
  return filtered.map((item) => listRow(item, activeId, schema, kind)).join('');
}

function listFilterConfig(kind) {
  if (kind === 'purchase') {
    return {
      selectKey: 'vendor',
      selectLabel: 'Fornecedor',
      selectAll: 'Todos os fornecedores',
      dateMode: 'header',
      dateKeys: ['order_deadline', 'expected_arrival'],
      searchPlaceholder: 'Buscar por título, número, fornecedor…',
    };
  }
  if (kind === 'sale') {
    return {
      selectKey: 'customer',
      selectLabel: 'Cliente',
      selectAll: 'Todos os clientes',
      dateMode: 'header',
      dateKeys: ['order_date', 'expiration'],
      searchPlaceholder: 'Buscar por título, número, cliente…',
    };
  }
  if (kind === 'production') {
    return {
      selectKey: 'input_product',
      selectLabel: 'Entrada',
      selectAll: 'Todos os produtos de entrada',
      dateMode: 'header',
      dateKeys: ['production_date'],
      searchPlaceholder: 'Buscar por título, material, ordem…',
    };
  }
  if (kind === 'product') {
    return {
      selectKey: 'category',
      selectLabel: 'Categoria',
      selectAll: 'Todas as categorias',
      dateMode: 'updated',
      dateKeys: [],
      searchPlaceholder: 'Buscar por nome, referência, categoria…',
    };
  }
  return {
    selectKey: '',
    selectLabel: '',
    selectAll: '',
    dateMode: '',
    dateKeys: [],
    searchPlaceholder: 'Buscar…',
  };
}

function partnerFilterOptions(items, kind) {
  const key = listFilterConfig(kind).selectKey;
  if (!key) return [];
  const names = new Set();
  for (const item of items || []) {
    const name = String(item.header?.[key] || '').trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/** Normaliza data do header (ISO ou dd/mm/aaaa) para AAAA-MM-DD. */
function itemFilterDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  return '';
}

function filterItems(items, schema, kind, filters) {
  const cfg = listFilterConfig(kind);
  const q = String(filters?.q || '')
    .trim()
    .toLowerCase();
  const partner = String(filters?.partner || '').trim().toLowerCase();
  const dateIso = toIsoDate(String(filters?.date || '').trim());
  const dateReady = /^\d{4}-\d{2}-\d{2}$/.test(dateIso);
  return items.filter((item) => {
    if (partner && cfg.selectKey) {
      const value = String(item.header?.[cfg.selectKey] || '')
        .trim()
        .toLowerCase();
      if (value !== partner) return false;
    }
    if (dateReady) {
      if (cfg.dateMode === 'updated') {
        const updated = itemFilterDate(item.updated_at);
        if (updated !== dateIso) return false;
      } else if (cfg.dateKeys?.length) {
        const hit = cfg.dateKeys.some((key) => itemFilterDate(item.header?.[key]) === dateIso);
        if (!hit) return false;
      }
    }
    if (!q) return true;
    const hay = [
      item.title,
      item.status,
      statusLabel(schema, kind, item.status),
      item.header?.order_reference,
      item.header?.odoo_id,
      item.header?.customer,
      item.header?.vendor,
      item.header?.name,
      item.header?.category,
      item.header?.internal_ref,
      item.header?.input_product,
      ...(Array.isArray(item.lines) ? item.lines.map((line) => line.values?.product) : []),
    ]
      .map((part) => String(part || '').toLowerCase())
      .join(' ');
    return hay.includes(q);
  });
}

function bindShellActions(root, kind, schema, catalog, items, token, presets = []) {
  if (kind === 'cadastros') {
    root.querySelector('[data-new]')?.addEventListener('click', () => {
      root.querySelector('[data-entities-new]')?.click();
    });
    return;
  }

  root.querySelector('[data-new]')?.addEventListener('click', () => {
    openNewRecord(root, kind, schema, catalog, items, token);
  });

  root.querySelectorAll('[data-preset-new]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-preset-new');
      try {
        // Recarrega da API — evita usar cópia antiga da toolbar após editar o padrão.
        const fresh = await loadPresets(kind);
        const preset = (fresh || []).find((item) => item.id === id);
        if (!preset) {
          toast('Padrão não encontrado');
          return;
        }
        openNewFromPreset(root, kind, schema, catalog, items, token, preset);
      } catch (error) {
        toast(error.message || 'Falha ao abrir padrão');
      }
    });
  });

  root.querySelector('[data-presets]')?.addEventListener('click', () => {
    showPresetsManager(root, kind, schema, catalog, items, token, presets);
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

function paint(root, kind, schema, catalog, items, editing, token, presets = []) {
  const body = ensureFormsShell(root, kind, presets);
  paintBody(body, kind, schema, catalog, items, editing);
  bindShellActions(root, kind, schema, catalog, items, token, presets);
  bindFilters(root, kind, schema, catalog, items, token);
  bindList(root, kind, schema, catalog, items, token);
  if (editing) {
    openEditorModal(root);
    bindEditor(root, kind, schema, catalog, items, editing, token);
  } else {
    closeEditorModal(root);
  }
}

function bindFilters(root, kind, schema, catalog, items, token) {
  rememberListSession(kind, schema, catalog, items, token);
  const qInput = root.querySelector('#forms-filter-q');
  const partnerSelect = root.querySelector('#forms-filter-partner');
  const dateInput = root.querySelector('#forms-filter-date');
  const apply = () => {
    const sess = listSession;
    listFilters = {
      q: qInput?.value || '',
      partner: partnerSelect?.value || '',
      date: dateInput?.value || '',
      kind: sess.kind || kind,
    };
    const filtered = filterItems(sess.items, sess.schema || schema, sess.kind || kind, listFilters);
    const list = root.querySelector('#forms-list');
    const count = root.querySelector('#forms-list-count');
    if (list) {
      list.innerHTML = listRowsHtml(
        filtered,
        null,
        sess.schema || schema,
        sess.kind || kind,
        sess.items.length,
      );
      bindList(root, sess.kind || kind, sess.schema || schema, sess.catalog || catalog, sess.items, sess.token || token);
    }
    if (count) {
      count.textContent =
        filtered.length === sess.items.length
          ? `${sess.items.length} item(ns)`
          : `${filtered.length} de ${sess.items.length} item(ns)`;
    }
  };
  if (dateInput) bindDateInputs(dateInput.closest('#forms-filters') || root);
  if (qInput?.dataset.boundFilters === '1') return;
  if (qInput) qInput.dataset.boundFilters = '1';
  if (partnerSelect) partnerSelect.dataset.boundFilters = '1';
  if (dateInput) dateInput.dataset.boundFilters = '1';
  qInput?.addEventListener('input', apply);
  partnerSelect?.addEventListener('change', apply);
  dateInput?.addEventListener('input', apply);
  dateInput?.addEventListener('change', apply);
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

/** Como no Odoo: pedido confirmado segue editável; só bloqueado/cancelado trava. */
function isOrderLocked(doc, kind) {
  if (kind === 'production') return isProductionLocked(doc);
  if (kind !== 'sale' && kind !== 'purchase') return false;
  const state = String(doc?.header?.odoo_state || doc?.status || 'draft').toLowerCase();
  return state === 'done' || state === 'cancel';
}

function blankDraft(kind, schema) {
  const fields = schema.fields[kind] || { header: [], lines: [] };
  const header = {};
  for (const field of fields.header || []) {
    header[field.key] = field.key === 'track_inventory' ? 'True' : '';
  }
  const hasLines = (fields.lines || []).length > 0;
  const lineValues = {};
  for (const field of fields.lines || []) lineValues[field.key] = '';
  if (kind === 'production') header.production_date = new Date().toISOString().slice(0, 10);
  return {
    id: '',
    kind,
    title:
      kind === 'sale'
        ? 'Cotação'
        : kind === 'purchase'
          ? 'Solicitação'
          : kind === 'production'
            ? 'Fabricação'
            : 'Produto',
    status: kind === 'production' ? 'done' : 'draft',
    header,
    lines: hasLines ? [{ id: '', values: lineValues }] : [],
    updated_at: '',
  };
}

function openNewRecord(root, kind, schema, catalog, items, token) {
  if (!schema?.fields?.[kind]) {
    toast('Schema do formulário indisponível');
    return;
  }
  const draft = blankDraft(kind, schema);
  ensureFormsModal(root);
  const editor = getFormsEditor(root);
  if (!editor) {
    toast('Não foi possível abrir o editor');
    return;
  }
  root.querySelectorAll('.forms-list-item.active').forEach((el) => el.classList.remove('active'));
  editor.innerHTML = editorHtml(draft, schema.fields[kind], kind, catalog, schema);
  openEditorModal(root);
  bindEditor(root, kind, schema, catalog, items, draft, token);
}

async function applyPresetsToolbar(root, kind, schema, catalog, items, token) {
  const next = await loadPresets(kind).catch(() => []);
  ensureFormsShell(root, kind, next);
  bindShellActions(root, kind, schema, catalog, items, token, next);
  return next;
}

function showPresetsManager(root, kind, schema, catalog, items, token, presets) {
  openPresetsManager(root, kind, presets || [], {
    openPresetEditor: (preset) => {
      openPresetEditor(root, kind, schema, catalog, items, token, preset, async () => {
        const next = await applyPresetsToolbar(root, kind, schema, catalog, items, token);
        showPresetsManager(root, kind, schema, catalog, items, token, next);
      });
    },
    onPresetsChanged: async (list) => {
      ensureFormsShell(root, kind, list);
      bindShellActions(root, kind, schema, catalog, items, token, list);
    },
  });
}

function openNewFromPreset(root, kind, schema, catalog, items, token, preset) {
  if (!schema?.fields?.[kind]) {
    toast('Schema do formulário indisponível');
    return;
  }
  const fields = schema.fields[kind];
  const { draft, hide } = draftFromPreset(blankDraft(kind, schema), preset, fields);
  ensureFormsModal(root);
  const editor = getFormsEditor(root);
  if (!editor) {
    toast('Não foi possível abrir o editor');
    return;
  }
  root.querySelectorAll('.forms-list-item.active').forEach((el) => el.classList.remove('active'));
  editor.innerHTML = editorHtml(draft, fields, kind, catalog, schema, {
    hide,
    title: `Novo · ${preset.name}`,
    subtitle: 'Só os campos marcados como “Mostrar” no padrão aparecem aqui. Salve para criar.',
  });
  openEditorModal(root);
  bindEditor(root, kind, schema, catalog, items, draft, token);
}

function openPresetEditor(root, kind, schema, catalog, items, token, preset, onSaved) {
  if (!schema?.fields?.[kind]) {
    toast('Schema do formulário indisponível');
    return;
  }
  const fields = schema.fields[kind];
  const base = blankDraft(kind, schema);
  const draft = preset
    ? {
        ...base,
        // Título salvo (mesmo vazio) — não cair no default Cotação/Solicitação/Produto.
        title: typeof preset.title === 'string' ? preset.title : base.title,
        status: preset.status || base.status,
        header: { ...base.header, ...(preset.header || {}) },
        lines: Array.isArray(preset.lines)
          ? preset.lines.map((line) => ({ id: '', values: { ...(line.values || {}) } }))
          : base.lines,
      }
    : base;
  const presetShow = normalizePresetVisible(preset, fields, kind);
  ensureFormsModal(root);
  const editor = getFormsEditor(root);
  if (!editor) {
    toast('Não foi possível abrir o editor');
    return;
  }
  editor.innerHTML = editorHtml(draft, fields, kind, catalog, schema, {
    mode: 'preset',
    presetId: preset?.id || '',
    presetName: preset?.name || '',
    presetShow,
    botEnabled: Boolean(preset?.bot_enabled),
    botFrequency: preset?.bot_frequency || 'daily',
    botWeekday: preset?.bot_weekday ?? 1,
    botSendTime: preset?.bot_send_time || '08:00',
    botTemplateId: preset?.bot_template_id || '',
    botContactId: preset?.bot_contact_id || '',
    botRules: preset?.bot_rules || {},
    title: preset ? `Editar padrão · ${preset.name}` : 'Novo padrão',
    subtitle:
      'Marque “Mostrar” nos campos que o formulário (e o Bot) devem usar. Valores preenchidos viram padrão e não são perguntados no WhatsApp.',
  });
  openEditorModal(root);
  bindPresetEditor(root, kind, schema, catalog, items, token, preset, onSaved);
}

function bindPresetEditor(root, kind, schema, catalog, items, token, preset, onSaved) {
  const form =
    getFormsEditor(root)?.querySelector('#forms-form') || root.querySelector('#forms-form');
  if (!form) return;
  const fields = schema.fields[kind];
  bindPartnerCombos(form, catalog);
  bindProductCombos(form, catalog);
  bindCatalogCombos(form, catalog);
  bindDateInputs(form);
  bindProductAutofill(form, catalog);
  bindLineRemoves(form, catalog);

  const saveBtn = form.querySelector('[data-save]');
  if (saveBtn) saveBtn.hidden = false;

  form.querySelector('[data-add-line]')?.addEventListener('click', () => {
    const box = form.querySelector('#forms-lines');
    if (!box) return;
    const index = box.querySelectorAll('.forms-line').length;
    box.insertAdjacentHTML(
      'beforeend',
      lineHtml({ id: '', values: {} }, fields.lines, index, kind, null, catalog),
    );
    bindLineRemoves(form, catalog);
    bindProductCombos(form, catalog);
    bindCatalogCombos(form, catalog);
    bindProductAutofill(form, catalog);
  });

  form.querySelector('[data-preset-back]')?.addEventListener('click', async () => {
    if (typeof onSaved === 'function') await onSaved();
    else closeEditorModal(root);
  });

  bindPresetBotControls(form);
  loadPresetBotTemplates(form, preset?.bot_template_id || '');
  loadPresetBotContacts(form, preset?.bot_contact_id || '');
  if (preset?.id) loadPresetBotActivity(form, preset.id);
  bindPresetBotSendNow(form, preset);
  bindPresetBotNewContact(form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = String(new FormData(form).get('preset_name') || '').trim();
    if (!name) {
      toast('Informe o nome do padrão');
      return;
    }
    try {
      const data = new FormData(form);
      const payload = collectPayload(form, fields);
      const body = {
        kind,
        name,
        title: payload.title || '',
        status: payload.status,
        header: payload.header,
        lines: payload.lines || [],
        visible: collectPresetVisible(form, fields),
        bot_enabled: data.get('bot_enabled') === '1',
        bot_frequency: String(data.get('bot_frequency') || 'daily'),
        bot_weekday: Number(data.get('bot_weekday') || 1),
        bot_send_time: String(data.get('bot_send_time') || '08:00'),
        bot_template_id: String(data.get('bot_template_id') || ''),
        bot_contact_id: String(data.get('bot_contact_id') || ''),
        bot_rules: collectBotRules(data),
      };
      if (body.bot_enabled && !body.bot_contact_id) {
        toast('Selecione ou cadastre o contato que receberá o WhatsApp');
        return;
      }
      if (preset?.id) {
        await api(`/api/forms/presets/${encodeURIComponent(preset.id)}`, {
          method: 'PUT',
          body,
        });
        toast('Padrão atualizado');
      } else {
        await api('/api/forms/presets', { method: 'POST', body });
        toast('Padrão criado');
      }
      if (typeof onSaved === 'function') await onSaved();
    } catch (error) {
      toast(error.message || 'Falha ao salvar padrão');
    }
  });
}

/** Encerramento do Bot: vazio = padrão global (lembrete 15 min, encerra em 30 min). */
function botRulesHtml(rules = {}) {
  const minutes = (value) => (value == null ? '' : escapeHtml(String(value)));
  return `
          <fieldset class="forms-bot-rules">
            <legend>Encerramento da conversa</legend>
            <div class="grid-2">
              <label>Lembrete após (min parado)
                <input name="bot_idle_reminder_minutes" type="number" min="0" max="10080" step="1" placeholder="15 (padrão)" value="${minutes(rules.idle_reminder_minutes)}" />
              </label>
              <label>Encerrar após (min parado)
                <input name="bot_idle_close_minutes" type="number" min="0" max="10080" step="1" placeholder="30 (padrão)" value="${minutes(rules.idle_close_minutes)}" />
              </label>
            </div>
            <p class="muted">Se o contato enviar os dados e não responder “Mais produtos?”, o Bot lembra e depois registra sozinho. 0 desliga. Não envia no horário de silêncio (padrão 22h–7h).</p>
            <label class="forms-preset-show">
              <input type="checkbox" name="bot_confirm_before_close" value="1"${rules.confirm_before_close ? ' checked' : ''} />
              <span>Pedir confirmação antes de registrar (resumo + “sim / corrigir”)</span>
            </label>
          </fieldset>`;
}

function collectBotRules(data) {
  const minutes = (key) => {
    const raw = String(data.get(key) ?? '').trim();
    return raw === '' ? null : Number(raw);
  };
  return {
    idle_reminder_minutes: minutes('bot_idle_reminder_minutes'),
    idle_close_minutes: minutes('bot_idle_close_minutes'),
    confirm_before_close: data.get('bot_confirm_before_close') === '1',
  };
}

function bindPresetBotSendNow(form, preset) {
  const button = form.querySelector('[data-bot-send-now]');
  if (!button) return;
  button.addEventListener('click', async () => {
    if (!preset?.id) {
      toast('Salve o padrão antes de enviar');
      return;
    }
    if (!form.querySelector('[name=bot_enabled]')?.checked) {
      toast('Ative “Enviar pelo Vertice Bot” para disparar');
      return;
    }
    button.disabled = true;
    try {
      // Persiste agenda/template atuais sem fechar o editor — o horário marcado segue intacto.
      const data = new FormData(form);
      const contactId = String(data.get('bot_contact_id') || '');
      if (!contactId) {
        toast('Selecione o contato destinatário');
        return;
      }
      await api(`/api/forms/presets/${encodeURIComponent(preset.id)}`, {
        method: 'PUT',
        body: {
          bot_enabled: true,
          bot_frequency: String(data.get('bot_frequency') || 'daily'),
          bot_weekday: Number(data.get('bot_weekday') || 1),
          bot_send_time: String(data.get('bot_send_time') || '08:00'),
          bot_template_id: String(data.get('bot_template_id') || ''),
          bot_contact_id: contactId,
          bot_rules: collectBotRules(data),
        },
      });
      const result = await api(`/api/forms/presets/${encodeURIComponent(preset.id)}/bot-send`, {
        method: 'POST',
        body: {},
      });
      toast(`Enviado agora para ${result.phone || 'WhatsApp'}. A agenda continua ativa.`);
      await loadPresetBotActivity(form, preset.id);
    } catch (error) {
      toast(error.message || 'Falha ao enviar agora');
    } finally {
      button.disabled = false;
    }
  });
}

function bindPresetBotControls(form) {
  const enabled = form.querySelector('[name=bot_enabled]');
  const panel = form.querySelector('[data-bot-schedule]');
  const weekdayWrap = form.querySelector('[data-bot-weekday]');
  const frequency = form.querySelector('[name=bot_frequency]');
  const templateSelect = form.querySelector('[name=bot_template_id]');
  const templatePreview = form.querySelector('[data-bot-template-preview]');
  const sendNow = form.querySelector('[data-bot-send-now]');
  const sync = () => {
    const on = Boolean(enabled?.checked);
    if (panel) panel.hidden = !on;
    if (weekdayWrap) weekdayWrap.hidden = !on || frequency?.value !== 'weekly';
    if (sendNow && form.getAttribute('data-preset-id')) sendNow.disabled = !on;
  };
  const syncPreview = () => {
    if (!templatePreview || !templateSelect) return;
    const option = templateSelect.selectedOptions?.[0];
    const body = option?.dataset?.body || '';
    templatePreview.textContent = body
      ? body
      : 'Automático: usa o template padrão do sistema se a janela de 24h estiver fechada.';
  };
  enabled?.addEventListener('change', sync);
  frequency?.addEventListener('change', sync);
  templateSelect?.addEventListener('change', syncPreview);
  sync();
  syncPreview();
}

async function loadPresetBotTemplates(form, selectedId = '') {
  const select = form.querySelector('[name=bot_template_id]');
  if (!select) return;
  try {
    const data = await api('/api/questionnaires/templates');
    const items = Array.isArray(data.items) ? data.items : [];
    const fallback = selectedId || data.selectedId || '';
    const options = [
      `<option value="" data-body="">Automático (template padrão)</option>`,
      ...items.map((item) => {
        const pending = item.status === 'PENDING_APPROVAL' ? ' (pendente)' : '';
        const selected = item.id === fallback ? ' selected' : '';
        return `<option value="${escapeHtml(item.id)}" data-body="${escapeHtml(item.body || '')}"${selected}>${escapeHtml(item.name)}${pending}</option>`;
      }),
    ];
    select.innerHTML = options.join('');
    select.dispatchEvent(new Event('change'));
  } catch (error) {
    select.innerHTML = `<option value="">Falha ao carregar templates</option>`;
    const preview = form.querySelector('[data-bot-template-preview]');
    if (preview) preview.textContent = error.message || 'Não foi possível listar templates Meta.';
  }
}

async function loadPresetBotContacts(form, selectedId = '') {
  const select = form.querySelector('[data-bot-contact-select]');
  if (!select) return;
  try {
    const data = await api('/api/contacts');
    const items = Array.isArray(data.items) ? data.items : [];
    const options = [
      `<option value="">Selecione o contato…</option>`,
      ...items.map((item) => {
        const selected = item.id === selectedId ? ' selected' : '';
        const label = `${item.name || 'Sem nome'} · ${item.phone || 'sem número'}`;
        return `<option value="${escapeHtml(item.id)}"${selected}>${escapeHtml(label)}</option>`;
      }),
    ];
    select.innerHTML = options.join('');
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      select.insertAdjacentHTML(
        'beforeend',
        `<option value="${escapeHtml(selectedId)}" selected>Contato salvo (não listado)</option>`,
      );
    }
  } catch (error) {
    select.innerHTML = `<option value="">Falha ao carregar contatos</option>`;
    toast(error.message || 'Não foi possível listar contatos');
  }
}

function bindPresetBotNewContact(form) {
  const toggle = form.querySelector('[data-bot-toggle-new-contact]');
  const box = form.querySelector('[data-bot-new-contact]');
  const createBtn = form.querySelector('[data-bot-create-contact]');
  const select = form.querySelector('[data-bot-contact-select]');
  toggle?.addEventListener('click', () => {
    if (!box) return;
    box.hidden = !box.hidden;
  });
  createBtn?.addEventListener('click', async () => {
    const name = String(form.querySelector('[name=bot_new_contact_name]')?.value || '').trim();
    const phone = String(form.querySelector('[name=bot_new_contact_phone]')?.value || '').trim();
    if (!phone) {
      toast('Informe o WhatsApp do contato');
      return;
    }
    createBtn.disabled = true;
    try {
      const result = await api('/api/contacts', {
        method: 'POST',
        body: { name: name || phone, phone, email: '' },
      });
      const contact = result.contact || result;
      await loadPresetBotContacts(form, contact.id);
      if (select) select.value = contact.id;
      if (box) box.hidden = true;
      const nameInput = form.querySelector('[name=bot_new_contact_name]');
      const phoneInput = form.querySelector('[name=bot_new_contact_phone]');
      if (nameInput) nameInput.value = '';
      if (phoneInput) phoneInput.value = '';
      toast('Contato cadastrado e selecionado');
    } catch (error) {
      toast(error.message || 'Falha ao cadastrar contato');
    } finally {
      createBtn.disabled = false;
    }
  });
}

async function loadPresetBotActivity(form, presetId) {
  const box = form.querySelector('[data-bot-activity]');
  if (!box || !presetId) return;
  box.hidden = false;
  box.innerHTML = `<p class="muted" style="margin:0">Carregando envios e respostas…</p>`;
  try {
    const data = await api(`/api/forms/presets/${encodeURIComponent(presetId)}/bot-activity`);
    const sends = Array.isArray(data.sends) ? data.sends : [];
    const answers = Array.isArray(data.answers) ? data.answers : [];
    box.innerHTML = `
      <div class="forms-bot-activity-cols">
        <div>
          <strong class="forms-bot-activity-title">Últimos envios</strong>
          ${
            sends.length
              ? `<ul class="forms-bot-activity-list">${sends
                  .map(
                    (item) => `<li>
                      <span class="forms-bot-activity-meta">${escapeHtml(formatBotWhen(item.at))} · ${escapeHtml(item.contact_name || item.phone || '—')} · ${escapeHtml(item.status)}</span>
                      <span>${escapeHtml(item.preview || item.kind || 'mensagem')}</span>
                      ${item.error ? `<span class="muted">${escapeHtml(item.error)}</span>` : ''}
                    </li>`,
                  )
                  .join('')}</ul>`
              : '<p class="muted" style="margin:6px 0 0">Nenhum envio ainda.</p>'
          }
        </div>
        <div>
          <strong class="forms-bot-activity-title">Últimas respostas</strong>
          ${
            answers.length
              ? `<ul class="forms-bot-activity-list">${answers
                  .map(
                    (item) => `<li>
                      <span class="forms-bot-activity-meta">${escapeHtml(formatBotWhen(item.at || item.occurrence_date))} · ${escapeHtml(item.contact_name || item.contact_phone || '—')} · ${escapeHtml(item.cycle_status || '')}</span>
                      <span>${escapeHtml(item.question || 'Pergunta')}</span>
                      <span>${escapeHtml(item.answer || '—')}</span>
                    </li>`,
                  )
                  .join('')}</ul>`
              : '<p class="muted" style="margin:6px 0 0">Nenhuma resposta ainda.</p>'
          }
        </div>
      </div>`;
  } catch (error) {
    box.innerHTML = `<p class="muted" style="margin:0">${escapeHtml(error.message || 'Falha ao carregar atividade')}</p>`;
  }
}

function formatBotWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceBadgeHtml(doc) {
  if (String(doc?.header?.source || '') !== 'bot') return '';
  return `<span class="forms-badge forms-badge--bot" title="Criado pelo Vertice Bot">Bot</span>`;
}

/** Só aviso de erro — sucesso/pendente ficam silenciosos (sync em background). */
function syncBadgeHtml(doc) {
  if (!doc?.id) return '';
  const header = doc?.header || {};
  const rawError = String(header.odoo_sync_error || '').trim();
  if (!rawError) return '';
  const error = formatSyncError(rawError, 420);
  return `<div class="forms-sync-notice is-error" data-sync-badge role="alert" title="${escapeHtml(rawError)}">
      <span class="forms-sync-msg"><strong>Odoo · não sincronizado.</strong> ${escapeHtml(error)}</span>
      <button class="btn-ghost" type="button" data-odoo-retry>Tentar novamente</button>
    </div>`;
}

/** Atualiza a lista em silêncio após o push ao Odoo (sem reabrir o modal). */
/** Sync em background: não redesenha a lista (evita piscar). Só avisa se falhar. */
async function pollSyncStatus(root, kind, schema, docId, token, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (!isNavActive(token)) return;
    try {
      const detail = await api(`/api/forms/${encodeURIComponent(docId)}`);
      const item = detail.item;
      if (!item) return;
      if (item.header?.odoo_sync_pending === '1') continue;
      const err = String(item.header?.odoo_sync_error || '').trim();
      if (err) toast(`Odoo: ${formatSyncError(err, 220)}`, { tone: 'error' });
      return;
    } catch {
      return;
    }
  }
}

function shortProductLabel(name) {
  return String(name || '')
    .replace(/\s*[-–]\s*KG\s*$/i, '')
    .replace(/\s+KG\s*$/i, '')
    .trim();
}

/** Resumo compacto produto + qtd para o card da lista (o que couber). */
function listLinesPreview(item, kind) {
  if (kind === 'product') return '';
  const lines = Array.isArray(item.lines) ? item.lines : [];
  const parts = [];
  for (const line of lines) {
    const values = line?.values && typeof line.values === 'object' ? line.values : {};
    const product = shortProductLabel(values.product);
    const rawQty = String(values.quantity || '').trim();
    const lineUom = String(values.uom || '').trim();
    const qty = lineUom && rawQty ? `${rawQty} ${lineUom}` : rawQty;
    if (!product && !qty) continue;
    if (product && qty) parts.push(`${qty} ${product}`);
    else parts.push(product || qty);
  }
  return parts.join(' · ');
}

function listRow(item, activeId, schema, kind) {
  const when = item.updated_at ? new Date(item.updated_at).toLocaleString('pt-BR') : '';
  const ref = String(item.header?.order_reference || '').trim();
  const partner =
    kind === 'purchase'
      ? String(item.header?.vendor || '').trim()
      : kind === 'sale'
        ? String(item.header?.customer || '').trim()
        : '';
  const headline =
    kind === 'product'
      ? item.title || item.header?.name || 'Sem título'
      : kind === 'production'
        ? [item.title || 'Fabricação', productionInputLabel(item.header)].filter(Boolean).join(' · ')
      : ref && partner
        ? `${ref} · ${partner}`
        : ref || partner || item.title || 'Sem título';
  let odoo = '';
  if (item.header?.odoo_sync_pending === '1') odoo = ' · sync…';
  else if (item.header?.odoo_sync_error) {
    odoo = ` · ${formatSyncError(item.header.odoo_sync_error, 72)}`;
  } else if (item.header?.odoo_id && !ref) odoo = ` · Odoo #${item.header.odoo_id}`;
  const locked = isOrderLocked(item, kind) ? ' · bloqueado' : '';
  const botTag = String(item.header?.source || '') === 'bot' ? ' · Bot' : '';
  const linesPreview = listLinesPreview(item, kind);
  const fallbackMeta = `${kind === 'product' ? '' : `${statusLabel(schema, kind, item.status)} · `}${when}${odoo}${locked}${botTag}`;
  const subtitle = linesPreview
    ? `${linesPreview}${botTag}`
    : fallbackMeta;
  return `
    <button class="forms-list-item${item.id === activeId ? ' active' : ''}" type="button" data-open="${escapeHtml(item.id)}">
      <strong>${escapeHtml(headline)}</strong>
      <span class="forms-list-item-sub">${escapeHtml(subtitle)}</span>
    </button>`;
}

function presetShowToggle(name, checked) {
  return `<label class="forms-preset-show">
    <input type="checkbox" name="${escapeHtml(name)}" value="1"${checked ? ' checked' : ''} />
    <span>Mostrar</span>
  </label>`;
}

function wrapPresetField(innerHtml, showName, checked) {
  return `<div class="forms-preset-field">
    ${presetShowToggle(showName, checked)}
    ${innerHtml}
  </div>`;
}

function editorHtml(doc, fields, kind, catalog, schema, options = {}) {
  const isPreset = options.mode === 'preset';
  const isNew = !doc?.id;
  const hasLines = (fields.lines || []).length > 0;
  const statuses = statusOptions(schema, kind);
  const currentStatus = String(doc.header?.odoo_state || doc.status || 'draft');
  const confirmed = !isNew && !isPreset && isOrderLocked(doc, kind);
  const hide = options.hide || null;
  const hideTitle = Boolean(hide?.title);
  const hideStatus = Boolean(hide?.status);
  const hideHeader = hide?.header instanceof Set ? hide.header : new Set();
  const hideLines = Array.isArray(hide?.lines) ? hide.lines : [];
  /** Mesmo filtro de campos de linha para novas linhas (Adicionar linha). */
  const sharedLineHide = !isPreset && hideLines[0] instanceof Set ? hideLines[0] : null;
  const hiddenLineKeysAttr =
    sharedLineHide && sharedLineHide.size
      ? ` data-hidden-line-keys="${escapeHtml([...sharedLineHide].join(','))}"`
      : '';
  const presetShow = options.presetShow || null;
  const showHeaderSet = new Set(presetShow?.header || []);
  const showLineSet = new Set(presetShow?.lines || []);
  const heading =
    options.title || (isPreset ? 'Padrão' : isNew ? 'Novo registro' : 'Editar registro');
  const subtitle =
    options.subtitle ||
    (kind === 'production' && !isPreset
      ? confirmed
        ? 'Ordem de produção concluída/cancelada no Odoo — não pode ser alterada. Para desfazer, use “Desmontar” na ordem no Odoo.'
        : 'Ao salvar, a ordem de produção é concluída no Odoo: o componente sai do estoque e os produtos gerados entram. A 1ª linha é o produto principal; as demais, subprodutos.'
      : confirmed
      ? 'Pedido bloqueado ou cancelado no Odoo — não pode ser alterado no Vertice.'
      : (kind === 'purchase' || kind === 'sale') && !isPreset
        ? kind === 'purchase'
          ? 'Ao salvar, o pedido é confirmado no Odoo e o recebimento é validado (o estoque sobe). Alterações depois também atualizam o Odoo.'
          : 'Ao salvar, a venda é confirmada no Odoo e a entrega é validada (o estoque baixa). Alterações depois também atualizam o Odoo.'
      : isPreset
        ? 'Defina o nome do botão e os valores padrão.'
        : isNew
          ? 'Preencha e salve para criar. Fechar sem salvar não cria o registro.'
          : 'Altere um campo para salvar. O envio ao Odoo é automático.');

  // Compras, Vendas e Fabricação gravam dado real: o status é o do Odoo (só leitura).
  const odooDrivenStatus = kind === 'purchase' || kind === 'sale' || kind === 'production';
  const statusControl =
    statuses.length === 0
      ? isPreset
        ? `<input type="hidden" name="status" value="draft" />`
        : ''
      : odooDrivenStatus
        ? isPreset
          ? `<input type="hidden" name="status" value="${escapeHtml(currentStatus)}" />`
          : `<label>Status
        <input value="${escapeHtml(
          isNew
            ? kind === 'production'
              ? 'Concluído ao salvar'
              : 'Confirmado ao salvar'
            : statusLabel(schema, kind, currentStatus),
        )}" readonly />
      </label>
      <input type="hidden" name="status" value="${escapeHtml(currentStatus)}" />`
      : hideStatus && !isPreset
        ? `<input type="hidden" name="status" value="${escapeHtml(currentStatus)}" />`
        : (() => {
            const select = `<label>Status
        <select name="status">
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
            return isPreset
              ? wrapPresetField(select, 'show_status', Boolean(presetShow?.status))
              : select;
          })();

  const actions = isPreset
    ? `<button class="btn-ghost" type="button" data-preset-back>Voltar</button>
       <button class="btn" type="submit" data-save>Salvar padrão</button>`
    : `<button class="btn" type="submit" data-save hidden>Salvar</button>
       ${isNew ? '' : '<button class="btn-danger" type="button" data-delete>Excluir</button>'}
       <button class="btn-ghost" type="button" data-close-modal>Fechar</button>`;

  const headerFields = fields.header || [];
  const visibleHeader = isPreset
    ? headerFields
    : headerFields.filter((field) => !hideHeader.has(field.key));
  const hiddenHeaderHtml = isPreset
    ? ''
    : headerFields
        .filter((field) => hideHeader.has(field.key))
        .map((field) =>
          headerInput(field, doc.header?.[field.key] || '', kind, { hidden: true }),
        )
        .join('');

  const botFrequency = options.botFrequency || 'daily';
  const botWeekday = Number(options.botWeekday ?? 1);
  const botSendTime = options.botSendTime || '08:00';
  const dayOptions = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
    .map(
      (label, index) =>
        `<option value="${index}"${botWeekday === index ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const titleBlock = isPreset
    ? `<label>Nome do padrão (botão)
        <input name="preset_name" value="${escapeHtml(options.presetName || '')}" placeholder="ex.: Plastico" required maxlength="60" />
      </label>
      <div class="forms-bot-panel">
        <label class="forms-preset-show forms-preset-bot">
          <input type="checkbox" name="bot_enabled" value="1"${options.botEnabled ? ' checked' : ''} />
          <span>Enviar pelo Vertice Bot (WhatsApp)</span>
        </label>
        <div class="forms-bot-schedule" data-bot-schedule${options.botEnabled ? '' : ' hidden'}>
          <label>Contato destinatário
            <select name="bot_contact_id" data-bot-contact-select>
              <option value="">Carregando contatos…</option>
            </select>
          </label>
          <div class="forms-bot-contact-actions">
            <button class="btn-ghost" type="button" data-bot-toggle-new-contact>Novo contato</button>
          </div>
          <div class="forms-bot-new-contact" data-bot-new-contact hidden>
            <div class="grid-2">
              <label>Nome
                <input type="text" name="bot_new_contact_name" placeholder="Nome" autocomplete="off" />
              </label>
              <label>WhatsApp
                <input type="tel" name="bot_new_contact_phone" placeholder="ex.: 11999998888" autocomplete="off" />
              </label>
            </div>
            <button class="btn" type="button" data-bot-create-contact>Cadastrar e selecionar</button>
          </div>
          <div class="grid-2">
            <label>Frequência
              <select name="bot_frequency">
                <option value="daily"${botFrequency === 'daily' ? ' selected' : ''}>Todos os dias</option>
                <option value="weekdays"${botFrequency === 'weekdays' ? ' selected' : ''}>Dias úteis</option>
                <option value="weekly"${botFrequency === 'weekly' ? ' selected' : ''}>Um dia da semana</option>
              </select>
            </label>
            <label>Horário
              <input name="bot_send_time" type="time" value="${escapeHtml(botSendTime)}" required />
            </label>
          </div>
          <label data-bot-weekday${botFrequency === 'weekly' ? '' : ' hidden'}>Dia da semana
            <select name="bot_weekday">${dayOptions}</select>
          </label>
          <label>Template Meta (janela 24h)
            <select name="bot_template_id">
              <option value="">Carregando templates…</option>
            </select>
          </label>
          <p class="muted forms-bot-template-hint" data-bot-template-preview>Se a janela de 24h estiver fechada, o Bot envia este template antes das perguntas.</p>
          ${botRulesHtml(options.botRules)}
          <div class="forms-bot-send-row">
            <button class="btn" type="button" data-bot-send-now ${options.presetId ? '' : 'disabled'} title="${
              options.presetId
                ? 'Envia o questionário agora sem alterar a agenda'
                : 'Salve o padrão antes de enviar'
            }">Enviar agora</button>
            <span class="muted">Disparo imediato. Frequência e horário seguem valendo para os próximos envios.</span>
          </div>
        </div>
        <div class="forms-bot-activity" data-bot-activity hidden></div>
      </div>
      ${wrapPresetField(
        `<label>Título (no novo registro)
          <input name="title" value="${escapeHtml(doc.title || '')}" placeholder="Opcional" />
        </label>`,
        'show_title',
        Boolean(presetShow?.title),
      )}`
    : hideTitle
      ? `<input type="hidden" name="title" value="${escapeHtml(doc.title || '')}" />`
      : `<label>Título
          <input name="title" value="${escapeHtml(doc.title || '')}" />
        </label>`;

  const lineShowBar =
    isPreset && hasLines
      ? `<div class="forms-preset-line-show" role="group" aria-label="Campos de linha visíveis">
          ${(fields.lines || [])
            .map(
              (field) =>
                `<label class="forms-preset-show">
                  <input type="checkbox" name="show_l_${escapeHtml(field.key)}" value="1"${
                    showLineSet.has(field.key) ? ' checked' : ''
                  } />
                  <span>${escapeHtml(field.label)}</span>
                </label>`,
            )
            .join('')}
        </div>`
      : '';

  return `
    <form id="forms-form" data-id="${escapeHtml(doc.id || '')}" data-kind="${escapeHtml(kind)}"${
      isNew && !isPreset ? ' data-new-draft="1"' : ''
    }${isPreset ? ` data-preset-editor="1" data-preset-id="${escapeHtml(options.presetId || '')}"` : ''}>
      <div class="card-head forms-editor-head">
        <div>
          <h2 id="forms-editor-title">${escapeHtml(heading)}</h2>
          <p class="muted">${escapeHtml(subtitle)}</p>
        </div>
        <div class="row">
          ${actions}
        </div>
      </div>
      ${isPreset ? '' : `${sourceBadgeHtml(doc)}${syncBadgeHtml(doc)}`}
      ${titleBlock}
      ${statusControl}
      ${hiddenHeaderHtml}
      ${
        visibleHeader.length
          ? `<div class="forms-section">
        <h2>Dados principais</h2>
        <div class="grid-2">
          ${visibleHeader
            .map((field) => {
              const input = headerInput(field, doc.header?.[field.key] || '', kind);
              if (!isPreset) return input;
              return wrapPresetField(input, `show_h_${field.key}`, showHeaderSet.has(field.key));
            })
            .join('')}
        </div>
      </div>`
          : ''
      }
      ${
        hasLines
          ? `<div class="forms-section">
              <div class="row forms-lines-head">
                <h2>${kind === 'production' ? 'Produtos gerados' : 'Linhas de produto'}</h2>
                <button class="btn-ghost" type="button" data-add-line>Adicionar linha</button>
              </div>
              ${lineShowBar}
              <div id="forms-lines"${hiddenLineKeysAttr}>${(doc.lines || [])
                .map((line, index) =>
                  lineHtml(
                    line,
                    fields.lines,
                    index,
                    kind,
                    isPreset ? null : hideLines[index] || hideLines[0] || null,
                    catalog,
                  ),
                )
                .join('')}</div>
            </div>`
          : ''
      }
      ${
        kind === 'production' && !isPreset
          ? `<div class="forms-section" data-production-balance>${productionBalanceHtml(doc.header || {}, doc.lines || [], catalog)}</div>`
          : ''
      }
    </form>`;
}

function numberOf(value) {
  const match = /-?\d+(?:[.,]\d+)?/.exec(String(value || ''));
  return match ? Number(match[0].replace(',', '.')) : 0;
}

function formatKg(value) {
  return `${Number(value.toFixed(3)).toLocaleString('pt-BR')} kg`;
}

/** Ordem de produção concluída/cancelada no Odoo (mesma regra de isProductionLocked no servidor). */
function isProductionLocked(doc) {
  const state = String(doc?.header?.odoo_state || '').toLowerCase();
  return state === 'done' || state === 'cancel';
}

function productionInputLabel(header = {}) {
  const qty = numberOf(header.input_qty);
  if (qty <= 0) return '';
  return `${qty.toLocaleString('pt-BR')} ${header.input_uom || ''} de ${header.input_product || 'entrada'}`.replace(/\s+/g, ' ');
}

/** Unidade do Odoo (catálogo uom: raiz da árvore + fator), aceitando plural (“bags” → “Bag”). */
function uomInfo(catalog, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const items = catalog?.refs?.uom || [];
  const hit =
    items.find((item) => item.name.toLowerCase() === key) ||
    items.find((item) => item.name.toLowerCase().replace(/s$/, '') === key.replace(/s$/, ''));
  return hit ? { name: hit.name, root: hit.meta?.root_id || hit.odoo_id, factor: Number(hit.meta?.factor) || 1 } : null;
}

/** Mesma conversão do Odoo (forms-uom toKg): unidade vazia = unidade do produto. */
function qtyToKg(catalog, qty, uomName, productName) {
  const productUom =
    (catalog?.products || []).find(
      (item) => item.name.trim().toLowerCase() === String(productName || '').trim().toLowerCase(),
    )?.uom || '';
  const from = uomInfo(catalog, uomName || productUom);
  if (!from) return null;
  const kg = (catalog?.refs?.uom || []).find(
    (item) => item.name.toLowerCase() === 'kg' && (item.meta?.root_id || item.odoo_id) === from.root,
  );
  return kg ? (qty * from.factor) / (Number(kg.meta?.factor) || 1) : null;
}

/** Mesma regra de productionBalance (servidor): entrada e saída na unidade do Odoo e em kg. */
function productionBalanceHtml(header, lines, catalog) {
  const inputName = String(header.input_product || '').trim();
  const inputQty = numberOf(header.input_qty);
  const inputUom = String(header.input_uom || '').trim();
  const inputKg = inputQty > 0 ? qtyToKg(catalog, inputQty, inputUom, inputName) : null;
  const rows = lines
    .map((line) => line?.values || {})
    .filter((values) => String(values.product || '').trim() && numberOf(values.quantity) > 0)
    .map((values) => ({
      product: values.product,
      qty: numberOf(values.quantity),
      uom: values.uom || '',
      kg: qtyToKg(catalog, numberOf(values.quantity), values.uom, values.product),
    }));
  const outputKg = rows.length && rows.every((row) => row.kg != null) ? rows.reduce((sum, row) => sum + row.kg, 0) : null;
  const parts = [];
  if (inputQty > 0) {
    const inKg = inputKg != null && !/^kg$/i.test(inputUom) ? ` = ${formatKg(inputKg)}` : '';
    parts.push(
      `<p><strong>Componente:</strong> ${escapeHtml(`${inputQty.toLocaleString('pt-BR')} ${inputUom || ''}`.trim())}${escapeHtml(inKg)} de ${escapeHtml(inputName || 'entrada')}</p>`,
    );
  } else {
    parts.push('<p class="muted">Informe a quantidade de entrada.</p>');
  }
  rows.forEach((row, index) => {
    const label = index === 0 ? 'Produto principal' : 'Subproduto';
    const inKg = row.kg != null && !/^kg$/i.test(row.uom) && row.uom ? ` = ${formatKg(row.kg)}` : '';
    parts.push(
      `<p><strong>${label}:</strong> ${escapeHtml(row.product)} ${escapeHtml(`${row.qty.toLocaleString('pt-BR')} ${row.uom}`.trim())}${escapeHtml(inKg)}</p>`,
    );
  });
  if (inputKg != null && outputKg != null) {
    const loss = inputKg - outputKg;
    parts.push(
      loss >= 0
        ? `<p><strong>Perda:</strong> ${escapeHtml(formatKg(loss))} (${inputKg ? Math.round((loss / inputKg) * 100) : 0}%)</p>`
        : `<p class="forms-sync-notice is-error">A saída pesa ${escapeHtml(formatKg(-loss))} a mais que a entrada — confira a quantidade de entrada.</p>`,
    );
  }
  if (header.stock_warning) {
    parts.push(`<p class="forms-sync-notice is-error">${escapeHtml(header.stock_warning)}</p>`);
  }
  return `<h2>Balanço da ordem de produção</h2>${parts.join('')}`;
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

function headerInput(field, value, kind, options = {}) {
  if (options.hidden) {
    const stored = field.date ? toIsoDate(value) || value : value;
    return `<input type="hidden" name="h_${escapeHtml(field.key)}" value="${escapeHtml(stored || '')}" />`;
  }
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
  if ((field.key === 'name' && kind === 'product') || (field.key === 'input_product' && kind === 'production')) {
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
    const display =
      field.catalog === 'category' || field.catalog === 'uom' ? odooLabelPt(value) : value;
    return catalogComboField(field, display, { name: `h_${field.key}`, kind });
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

/** Lê o filtro de campos ocultos gravado em `#forms-lines` (vindo do padrão). */
function lineHiddenKeysFromBox(box) {
  const raw = String(box?.getAttribute('data-hidden-line-keys') || '').trim();
  if (!raw) return null;
  return new Set(raw.split(',').map((key) => key.trim()).filter(Boolean));
}

/** Copia valores dos campos ocultos da 1ª linha (pré-preenchidos pelo padrão). */
function lineHiddenValuesSeed(box, hiddenKeys) {
  if (!hiddenKeys?.size) return {};
  const first = box?.querySelector('.forms-line');
  if (!first) return {};
  const values = {};
  for (const key of hiddenKeys) {
    const input = first.querySelector(`[data-line-key="${key.replace(/"/g, '')}"]`);
    if (input) values[key] = input.value || '';
  }
  return values;
}

function quantityFieldLabel(uom) {
  const unit = odooLabelPt(String(uom || '').trim());
  return unit ? `Quantidade (${unit})` : 'Quantidade';
}

function resolveProductUom(productName, catalog) {
  const name = String(productName || '')
    .trim()
    .toLowerCase();
  if (!name) return '';
  const match = (catalog?.products || []).find(
    (item) => String(item.name || '').trim().toLowerCase() === name,
  );
  return match?.uom ? String(match.uom).trim() : '';
}

function syncLineQuantityLabels(root, catalog) {
  const scope = root?.querySelector?.('#forms-form') || root;
  if (!scope) return;
  scope.querySelectorAll('.forms-line').forEach((line) => {
    const label = line.querySelector('[data-qty-label]');
    if (!label) return;
    const product = line.querySelector('[data-line-key="product"]');
    label.textContent = quantityFieldLabel(resolveProductUom(product?.value, catalog));
  });
}

function lineHtml(line, lineFields, index, kind, hiddenKeys = null, catalog = null) {
  const hide = hiddenKeys instanceof Set ? hiddenKeys : new Set();
  const visibleFields = lineFields.filter((field) => !hide.has(field.key));
  const lineUom = resolveProductUom(line.values?.product, catalog);
  const hiddenInputs = lineFields
    .filter((field) => hide.has(field.key))
    .map(
      (field) =>
        `<input type="hidden" data-line-key="${escapeHtml(field.key)}" value="${escapeHtml(line.values?.[field.key] || '')}" />`,
    )
    .join('');
  return `
    <div class="forms-line" data-line-id="${escapeHtml(line.id || '')}">
      <div class="forms-line-top">
        <strong>Item ${index + 1}</strong>
        <button class="btn-ghost" type="button" data-remove-line>Remover</button>
      </div>
      ${hiddenInputs}
      ${
        visibleFields.length
          ? `<div class="grid-2">
        ${visibleFields
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
            if (field.key === 'quantity') {
              return `
          <label>
            <span data-qty-label>${escapeHtml(quantityFieldLabel(lineUom))}</span>
            <input data-line-key="quantity" value="${escapeHtml(line.values?.[field.key] || '')}" />
          </label>`;
            }
            return `
          <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}
            <input data-line-key="${escapeHtml(field.key)}" value="${escapeHtml(line.values?.[field.key] || '')}" />
          </label>`;
          })
          .join('')}
      </div>`
          : `<p class="muted forms-line-preset-note">Linha pré-preenchida pelo padrão</p>`
      }
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
  if (product.uom) bits.push(odooLabelPt(product.uom));
  if (product.category) bits.push(odooLabelPt(product.category));
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
    const localize = refType === 'category' || refType === 'uom';
    bindTextCombo(wrap, {
      items,
      getLabel: (item) => (localize ? odooLabelPt(item.name) : item.name),
      getValue: (item) => (localize ? odooLabelPt(item.name) : item.name),
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

  const placeMenu = () => {
    const rect = input.getBoundingClientRect();
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.style.position = 'fixed';
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.width = `${rect.width}px`;
    menu.style.right = 'auto';
    menu.style.zIndex = '320';
  };

  const onDocDown = (event) => {
    if (wrap.contains(event.target) || menu.contains(event.target)) return;
    close();
  };

  const onReposition = () => {
    if (!menu.hidden) placeMenu();
  };

  const close = () => {
    menu.hidden = true;
    menu.innerHTML = '';
    activeIndex = -1;
    wrap.classList.remove('is-open');
    if (menu.parentElement !== wrap) wrap.appendChild(menu);
    menu.removeAttribute('style');
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
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
      q
        ? pool.filter((item) => {
            const label = String(options.getLabel?.(item) || item.name || '').toLowerCase();
            return label.includes(q) || String(item.name || '').toLowerCase().includes(q);
          })
        : pool
    ).slice(0, 12);
    if (!matches.length) {
      menu.innerHTML = `<div class="forms-combo-empty">${escapeHtml(options.emptyLabel || 'Nenhum resultado')}</div>`;
    } else {
      menu.innerHTML = matches
        .map((item, index) => {
          const meta = options.getMeta?.(item) || '';
          const label = options.getLabel?.(item) || item.name || '';
          const pickValue = options.getValue?.(item) || label;
          return `<button type="button" class="forms-combo-option${
            index === activeIndex ? ' is-active' : ''
          }" data-combo-pick="${escapeHtml(pickValue)}" role="option">
            <strong>${escapeHtml(label)}</strong>
            ${meta ? `<span>${escapeHtml(meta)}</span>` : ''}
          </button>`;
        })
        .join('');
      menu.querySelectorAll('[data-combo-pick]').forEach((btn) => {
        btn.addEventListener('mousedown', (event) => {
          event.preventDefault();
          pick(btn.getAttribute('data-combo-pick') || '');
        });
      });
    }
    menu.hidden = false;
    wrap.classList.add('is-open');
    placeMenu();
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    if (!matches.length) activeIndex = -1;
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
    window.setTimeout(() => {
      if (!wrap.contains(document.activeElement) && !menu.contains(document.activeElement)) {
        close();
      }
    }, 120);
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

function applyProductLineHints(input, catalog) {
  const products = catalog.products || [];
  const match = products.find(
    (item) => item.name.trim().toLowerCase() === String(input.value || '').trim().toLowerCase(),
  );
  const line = input.closest('.forms-line');
  const qtyLabel = line?.querySelector('[data-qty-label]');
  if (qtyLabel) {
    qtyLabel.textContent = quantityFieldLabel(match?.uom || '');
  }
  if (!match) return;
  const price = line?.querySelector('[data-line-key="unit_price"]');
  if (!price || price.value.trim()) return;
  const kind = input.getAttribute('data-price-kind');
  price.value =
    kind === 'purchase' ? match.cost || match.sales_price || '' : match.sales_price || match.cost || '';
  price.dispatchEvent(new Event('input', { bubbles: true }));
}

function bindProductCombos(form, catalog) {
  form.querySelectorAll('[data-product-combo]').forEach((wrap) => {
    bindTextCombo(wrap, {
      items: catalog.products || [],
      getMeta: productMeta,
      emptyLabel: 'Nenhum produto encontrado',
      onPick: (input) => applyProductLineHints(input, catalog),
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
        ensureFormsModal(root);
        const editor = getFormsEditor(root);
        if (!editor) {
          toast('Não foi possível abrir o editor');
          return;
        }
        editor.innerHTML = editorHtml(found, schema.fields[kind], kind, catalog, schema);
        root.querySelectorAll('.forms-list-item.active').forEach((el) => el.classList.remove('active'));
        button.classList.add('active');
        openEditorModal(root);
        bindEditor(root, kind, schema, catalog, nextItems, found, token);
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function bindEditor(root, kind, schema, catalog, items, doc, token) {
  const form = getFormsEditor(root)?.querySelector('#forms-form') || root.querySelector('#forms-form');
  if (!form) return;
  const fields = schema.fields[kind];
  bindPartnerCombos(form, catalog);
  bindProductCombos(form, catalog);
  bindCatalogCombos(form, catalog);
  bindDateInputs(form);
  bindProductAutofill(form, catalog);
  bindLineRemoves(form, catalog);
  bindDirtySave(form, fields);

  const balanceBox = form.querySelector('[data-production-balance]');
  if (balanceBox) {
    const refreshBalance = () => {
      const payload = collectPayload(form, fields);
      balanceBox.innerHTML = productionBalanceHtml(
        { ...(doc.header || {}), ...(payload.header || {}) },
        payload.lines || [],
        catalog,
      );
    };
    form._refreshProduction = refreshBalance;
    form.addEventListener('input', refreshBalance);
    form.addEventListener('change', refreshBalance);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveBtn = form.querySelector('[data-save]');
    if (saveBtn?.hidden) return;
    try {
      const payload = collectPayload(form, fields);
      if (
        kind === 'production' &&
        payload.status === 'done' &&
        !isProductionLocked(doc) &&
        !confirm('Concluir a ordem de produção no Odoo? O componente sai do estoque e os produtos gerados entram — depois não dá para editar.')
      ) {
        return;
      }
      let id = doc.id;
      if (!id) {
        const created = await api('/api/forms', { method: 'POST', body: { kind } });
        id = created.item?.id;
        if (!id) throw new Error('Falha ao criar registro');
      }
      await api(`/api/forms/${id}`, { method: 'PUT', body: payload });
      closeEditorModal(root);
      await refreshListQuiet(root, kind, schema, token);
      void pollSyncStatus(root, kind, schema, id, token);
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });

  form.querySelector('[data-odoo-retry]')?.addEventListener('click', async () => {
    if (!doc.id) return;
    try {
      await api(`/api/forms/${doc.id}/odoo-push`, { method: 'POST', body: {} });
      closeEditorModal(root);
      await refreshListQuiet(root, kind, schema, token);
      void pollSyncStatus(root, kind, schema, doc.id, token);
    } catch (error) {
      toast(`Odoo: ${formatSyncError(error.message || error)}`, { tone: 'error' });
    }
  });

  form.querySelector('[data-add-line]')?.addEventListener('click', () => {
    const box = form.querySelector('#forms-lines');
    if (!box) return;
    const index = box.querySelectorAll('.forms-line').length;
    const hiddenKeys = lineHiddenKeysFromBox(box);
    const values = lineHiddenValuesSeed(box, hiddenKeys);
    box.insertAdjacentHTML(
      'beforeend',
      lineHtml({ id: '', values }, fields.lines, index, kind, hiddenKeys, catalog),
    );
    bindLineRemoves(form, catalog);
    bindProductCombos(form, catalog);
    bindCatalogCombos(form, catalog);
    bindProductAutofill(form, catalog);
    syncLineQuantityLabels(form, catalog);
    form._refreshProduction?.();
    form._checkDirty?.();
  });

  form.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!doc.id) return;
    const question =
      kind === 'production'
        ? 'Excluir esta fabricação? A ordem de produção será cancelada no Odoo (nada foi lançado no estoque).'
        : 'Excluir este registro? O pedido correspondente será cancelado no Odoo.';
    if (!confirm(question)) return;
    try {
      await api(`/api/forms/${doc.id}`, { method: 'DELETE' });
      toast('Excluído · cancelado no Odoo', { tone: 'subtle' });
      closeEditorModal(root);
      await refreshListQuiet(root, kind, schema, token);
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });

}

function bindDirtySave(form, fields) {
  const saveBtn = form.querySelector('[data-save]');
  if (!saveBtn) return;
  let baseline = '';
  const snapshot = () => JSON.stringify(collectPayload(form, fields));
  const checkDirty = () => {
    saveBtn.hidden = snapshot() === baseline;
  };
  // Baseline após combos/máscaras estabilizarem os valores iniciais.
  baseline = snapshot();
  saveBtn.hidden = true;
  form._checkDirty = checkDirty;
  form.addEventListener('input', checkDirty);
  form.addEventListener('change', checkDirty);
}

function bindProductAutofill(form, catalog) {
  form.querySelectorAll('[data-product-input]').forEach((input) => {
    if (input.dataset.boundCatalog === '1') return;
    input.dataset.boundCatalog = '1';
    input.addEventListener('change', () => applyProductLineHints(input, catalog));
  });
  syncLineQuantityLabels(form, catalog);
}

function bindLineRemoves(form, catalog) {
  form.querySelectorAll('[data-remove-line]').forEach((button) => {
    button.onclick = () => {
      button.closest('.forms-line')?.remove();
      form._checkDirty?.();
    };
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

/**
 * Atualiza só as linhas da lista (sem remontar toolbar/modal).
 * Usado após salvar/excluir e no poll automático enquanto a aba Forms está aberta.
 */
async function refreshListQuiet(root, kind, schema, token, options = {}) {
  const keepEditor = Boolean(options.keepEditor);
  const [catalog, data] = await Promise.all([
    loadCatalog(false),
    api(`/api/forms?kind=${encodeURIComponent(kind)}&lines=1`),
  ]);
  if (!isNavActive(token)) return;
  const items = data.items || [];
  const list = root.querySelector('#forms-list');
  const count = root.querySelector('#forms-list-count');
  if (!list) {
    if (!keepEditor) await refresh(root, kind, schema, null, token);
    return;
  }
  if (keepEditor && listFingerprint(items) === listFingerprint(listSession.items)) {
    rememberListSession(kind, schema, catalog, items, token);
    return;
  }
  const activeId =
    root.querySelector('.forms-list-item.active')?.getAttribute('data-open') ||
    (keepEditor
      ? getFormsEditor(root)?.querySelector('#forms-form')?.getAttribute('data-id') || ''
      : '');
  rememberListSession(kind, schema, catalog, items, token);
  const filtered = filterItems(items, schema, kind, listFilters);
  list.innerHTML = listRowsHtml(filtered, activeId || null, schema, kind, items.length);
  if (count) {
    count.textContent =
      filtered.length === items.length
        ? `${items.length} item(ns)`
        : `${filtered.length} de ${items.length} item(ns)`;
  }
  const partnerSelect = root.querySelector('#forms-filter-partner');
  if (partnerSelect) {
    const selected = listFilters.partner || partnerSelect.value || '';
    const opts = partnerFilterOptions(items, kind);
    partnerSelect.innerHTML = [
      `<option value="">${escapeHtml(listFilterConfig(kind).selectAll || 'Todos')}</option>`,
      ...opts.map(
        (name) =>
          `<option value="${escapeHtml(name)}"${selected === name ? ' selected' : ''}>${escapeHtml(name)}</option>`,
      ),
    ].join('');
  }
  bindList(root, kind, schema, catalog, items, token);
  if (!keepEditor) closeEditorModal(root);
}

async function refresh(root, kind, schema, openId, token) {
  const [catalog, data, presets] = await Promise.all([
    loadCatalog(false),
    api(`/api/forms?kind=${encodeURIComponent(kind)}&lines=1`),
    loadPresets(kind).catch(() => []),
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
  rememberListSession(kind, schema, catalog, items, token);
  const body = ensureFormsShell(root, kind, presets);
  paintBody(body, kind, schema, catalog, items, editing);
  bindShellActions(root, kind, schema, catalog, items, token, presets);
  bindFilters(root, kind, schema, catalog, items, token);
  bindList(root, kind, schema, catalog, items, token);
  if (editing) {
    openEditorModal(root);
    bindEditor(root, kind, schema, catalog, items, editing, token);
  } else {
    closeEditorModal(root);
  }
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
