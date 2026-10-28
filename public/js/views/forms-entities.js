import { api } from '../api.js';
import { odooLabelPt } from '../odoo-pt.js';
import { escapeHtml, formatSyncError, toast } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';
import {
  closeEditorModal,
  ensureFormsModal,
  formsModalShellHtml,
  getFormsEditor,
  openEditorModal,
} from './forms-modal.js';

/** Só erro — sync bem-sucedido fica silencioso. */
function entitySyncNoticeHtml(item) {
  const err = String(item?.odoo_sync_error || '').trim();
  if (!err) return '';
  return `<div class="forms-sync-notice is-error" role="alert" title="${escapeHtml(err)}">
      <span class="forms-sync-msg"><strong>Odoo · não sincronizado.</strong> ${escapeHtml(formatSyncError(err, 420))}</span>
      ${item?.id ? '<button class="btn-ghost" type="button" data-odoo-push>Tentar novamente</button>' : ''}
    </div>`;
}

/** Sync em background: não redesenha a lista. Só avisa se falhar. */
async function pollEntityProductSync(productId, token, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (!isNavActive(token)) return;
    try {
      const detail = await api(`/api/forms/${encodeURIComponent(productId)}`);
      const header = detail.item?.header || {};
      if (header.odoo_sync_pending === '1') continue;
      const err = String(header.odoo_sync_error || '').trim();
      if (err) toast(`Odoo: ${formatSyncError(err, 220)}`, { tone: 'error' });
      return;
    } catch {
      return;
    }
  }
}

/** Parceiros: sync em background sem segundo reload da lista. */
async function pollEntityPartnerSync(partnerId, role, token, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (!isNavActive(token)) return;
    try {
      const list = await api(`/api/forms/entities/partners?role=${encodeURIComponent(role)}`);
      const found = (list.items || []).find((row) => row.id === partnerId);
      if (!found) return;
      const err = String(found.odoo_sync_error || '').trim();
      if (err) {
        toast(`Odoo: ${formatSyncError(err, 220)}`, { tone: 'error' });
        return;
      }
      // Sem odoo_id ainda e sem erro → pode ainda estar sincronizando.
      if (!found.odoo_id) continue;
      return;
    } catch {
      return;
    }
  }
}

const ENTITY_TABS = [
  { id: 'produtos', label: 'Produtos' },
  { id: 'clientes', label: 'Clientes' },
  { id: 'fornecedores', label: 'Fornecedores' },
];

let entityListFilter = { q: '', entity: '' };

export function entityFromSlug(slug) {
  const part =
    String(slug || '')
      .replace(/^cadastros\/?/, '')
      .replace(/^dados\/?/, '') || 'produtos';
  return ENTITY_TABS.some((tab) => tab.id === part) ? part : 'produtos';
}

/** Preenche só o corpo da aba Cadastros (shell do Forms permanece). */
export async function renderEntitiesBody(body, entity = 'produtos', token = getNavToken(), root = null) {
  if (!body) return;
  document.querySelectorAll('body > #forms-modal').forEach((el) => el.remove());
  document.body.classList.remove('forms-modal-open');

  const summary = await api('/api/forms/entities/summary').catch(() => ({
    products: 0,
    customers: 0,
    vendors: 0,
  }));
  if (!isNavActive(token)) return;

  if (entityListFilter.entity !== entity) {
    entityListFilter = { q: '', entity };
  }

  const shellRoot = root || body.closest('#forms-view') || body;

  body.innerHTML = `
    <div class="forms-catalog-bar muted">
      Cadastros Odoo: <strong>${summary.products || 0}</strong> produtos ·
      <strong>${summary.customers || 0}</strong> clientes ·
      <strong>${summary.vendors || 0}</strong> fornecedores
      · salvar localmente e enviar ao Odoo quando quiser
    </div>
    <nav class="settings-tabs forms-tabs forms-entity-tabs" aria-label="Tipos de cadastro">
      ${ENTITY_TABS.map(
        (tab) =>
          `<a class="settings-tab${tab.id === entity ? ' active' : ''}" href="#/forms/cadastros/${tab.id}">${escapeHtml(tab.label)}</a>`,
      ).join('')}
    </nav>
    <div class="forms-layout">
      <section class="card forms-list-card" id="entities-panel"></section>
    </div>
    ${formsModalShellHtml()}
    <button type="button" hidden data-entities-new></button>`;

  const panel = body.querySelector('#entities-panel');
  const role = entity === 'clientes' ? 'customer' : 'vendor';
  /**
   * Atualiza a lista. Por padrão é soft (só linhas) — evita piscar toolbar/abas.
   * Sync do Odoo nunca deve chamar isto; só save/delete/retry.
   */
  const reloadList = async (opts = {}) => {
    const listPanel = body.querySelector('#entities-panel');
    if (!listPanel || !isNavActive(token)) return;
    const soft = opts.soft !== false;
    if (entity === 'produtos') await paintProducts(listPanel, shellRoot, reloadList, token, { soft });
    else await paintPartners(listPanel, shellRoot, reloadList, role, token, { soft });
  };

  body.querySelector('[data-entities-new]')?.addEventListener('click', () => {
    if (entity === 'produtos') openProductEditor(shellRoot, reloadList, null, token);
    else openPartnerEditor(shellRoot, reloadList, role, null, token);
  });

  if (entity === 'produtos') await paintProducts(panel, shellRoot, reloadList, token);
  else await paintPartners(panel, shellRoot, reloadList, role, token);
}

function filterEntityItems(items, q) {
  const query = String(q || '')
    .trim()
    .toLowerCase();
  if (!query) return items;
  return items.filter((item) => {
    const hay = [
      item.name,
      item.internal_ref,
      item.category,
      item.uom,
      item.odoo_id,
      item.vat,
      item.email,
      item.phone,
      item.city,
    ]
      .map((part) => String(part || '').toLowerCase())
      .join(' ');
    return hay.includes(query);
  });
}

function bindEntityDirtySave(form) {
  const saveBtn = form.querySelector('[data-save]');
  if (!saveBtn) return;
  const snapshot = () => {
    const data = new FormData(form);
    return JSON.stringify([...data.entries()]);
  };
  let baseline = snapshot();
  const check = () => {
    saveBtn.hidden = snapshot() === baseline;
  };
  saveBtn.hidden = true;
  form.addEventListener('input', check);
  form.addEventListener('change', check);
  form._checkDirty = check;
  form._resetDirty = () => {
    baseline = snapshot();
    saveBtn.hidden = true;
  };
}

async function paintProducts(panel, root, reload, token, opts = {}) {
  const data = await api('/api/forms/entities/products');
  if (!isNavActive(token)) return;
  const items = data.items || [];
  const filtered = filterEntityItems(items, entityListFilter.q);
  const countLabel =
    filtered.length === items.length
      ? `${items.length} cadastro(s)`
      : `${filtered.length} de ${items.length} cadastro(s)`;

  const renderRows = (rows) => {
    if (!rows.length) {
      return items.length
        ? '<p class="muted">Nenhum cadastro corresponde à busca.</p>'
        : '<p class="muted">Nenhum produto. Use Configurações → Receber dados ou “Novo”.</p>';
    }
    return rows
      .map(
        (item) => `
        <button class="forms-list-item" type="button" data-edit-product="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.name || 'Sem nome')}</strong>
          <span>${escapeHtml(
            [
              item.internal_ref,
              item.category && odooLabelPt(item.category),
              item.uom && odooLabelPt(item.uom),
              item.sales_price && `venda ${item.sales_price}`,
              item.odoo_id && `Odoo #${item.odoo_id}`,
            ]
              .filter(Boolean)
              .join(' · ') || 'Sem detalhes',
          )}</span>
        </button>`,
      )
      .join('');
  };

  const bindRows = () => {
    panel.querySelectorAll('[data-edit-product]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-edit-product');
        const item = items.find((row) => row.id === id);
        panel.querySelectorAll('.forms-list-item.active').forEach((el) => el.classList.remove('active'));
        button.classList.add('active');
        openProductEditor(root, reload, item, token);
      });
    });
  };

  const bindSearch = () => {
    const input = panel.querySelector('#entities-filter-q');
    const count = panel.querySelector('#entities-list-count');
    const list = panel.querySelector('#entities-list');
    if (!input || input.dataset.boundSearch === '1') return;
    input.dataset.boundSearch = '1';
    input.addEventListener('input', () => {
      entityListFilter = { ...entityListFilter, q: input.value || '' };
      const next = filterEntityItems(items, entityListFilter.q);
      if (list) list.innerHTML = renderRows(next);
      if (count) {
        count.textContent =
          next.length === items.length
            ? `${items.length} cadastro(s)`
            : `${next.length} de ${items.length} cadastro(s)`;
      }
      bindRows();
    });
  };

  const existingList = panel.querySelector('#entities-list');
  const existingCount = panel.querySelector('#entities-list-count');
  if (opts.soft && existingList && existingCount) {
    existingList.innerHTML = renderRows(filtered);
    existingCount.textContent = countLabel;
    const oldInput = panel.querySelector('#entities-filter-q');
    if (oldInput) {
      const nextInput = oldInput.cloneNode(true);
      delete nextInput.dataset.boundSearch;
      oldInput.replaceWith(nextInput);
    }
    bindSearch();
    bindRows();
    return;
  }

  panel.innerHTML = `
    <div class="card-head forms-list-head">
      <div>
        <h2>Produtos</h2>
        <p class="muted" id="entities-list-count">${escapeHtml(countLabel)}</p>
      </div>
    </div>
    <div class="forms-filters">
      <label class="forms-filter-search">
        <span class="sr-only">Buscar</span>
        <input type="search" id="entities-filter-q" placeholder="Buscar por nome, referência, categoria…" value="${escapeHtml(entityListFilter.q)}" autocomplete="off" />
      </label>
    </div>
    <div class="forms-list" id="entities-list">${renderRows(filtered)}</div>`;

  bindSearch();
  bindRows();
}

function entityCombo(name, label, value, placeholder) {
  return `
    <label class="forms-combo-label">${escapeHtml(label)}
      <div class="forms-combo" data-entity-ref="${escapeHtml(name)}">
        <input name="${escapeHtml(name)}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" data-combo-input />
        <div class="forms-combo-menu" data-combo-menu hidden role="listbox"></div>
      </div>
    </label>`;
}

function bindEntityRefCombos(form, refs) {
  form.querySelectorAll('[data-entity-ref]').forEach((wrap) => {
    if (wrap.dataset.boundCombo === '1') return;
    wrap.dataset.boundCombo = '1';
    const key = wrap.getAttribute('data-entity-ref');
    const items = refs[key === 'category' ? 'category' : key === 'uom' ? 'uom' : ''] || [];
    const input = wrap.querySelector('[data-combo-input]');
    const menu = wrap.querySelector('[data-combo-menu]');
    if (!input || !menu) return;

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
      wrap.classList.remove('is-open');
      if (menu.parentElement !== wrap) wrap.appendChild(menu);
      menu.removeAttribute('style');
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };

    const paint = (query) => {
      const q = String(query || '')
        .trim()
        .toLowerCase();
      const labelOf = (item) => odooLabelPt(item.name || '');
      const matches = (
        q ? items.filter((item) => labelOf(item).toLowerCase().includes(q) || item.name.toLowerCase().includes(q)) : items
      ).slice(0, 12);
      if (!matches.length) {
        menu.innerHTML = '<div class="forms-combo-empty">Nenhuma opção Odoo (Receber dados)</div>';
      } else {
        menu.innerHTML = matches
          .map(
            (item) =>
              `<button type="button" class="forms-combo-option" data-combo-pick="${escapeHtml(labelOf(item))}">
              <strong>${escapeHtml(labelOf(item))}</strong>
              ${item.odoo_id ? `<span>Odoo #${escapeHtml(item.odoo_id)}</span>` : ''}
            </button>`,
          )
          .join('');
        menu.querySelectorAll('[data-combo-pick]').forEach((btn) => {
          btn.addEventListener('mousedown', (event) => {
            event.preventDefault();
            input.value = btn.getAttribute('data-combo-pick') || '';
            close();
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
        });
      }
      menu.hidden = false;
      wrap.classList.add('is-open');
      placeMenu();
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('scroll', onReposition, true);
      window.addEventListener('resize', onReposition);
    };

    input.addEventListener('focus', () => paint(input.value));
    input.addEventListener('input', () => paint(input.value));
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!wrap.contains(document.activeElement) && !menu.contains(document.activeElement)) close();
      }, 120);
    });
  });
}

async function openProductEditor(root, reload, item, token) {
  const value = item || {
    id: '',
    name: '',
    category: '',
    sales_price: '',
    cost: '',
    uom: '',
    internal_ref: '',
    weight: '',
    qty_on_hand: '',
    track_inventory: 'True',
    odoo_id: '',
  };
  const catalog = await api('/api/forms/catalog').catch(() => ({ refs: {} }));
  if (!isNavActive(token)) return;

  ensureFormsModal(root);
  const editor = getFormsEditor(root);
  if (!editor) {
    toast('Não foi possível abrir o editor');
    return;
  }

  editor.innerHTML = `
    <form id="entity-form">
      <div class="card-head forms-editor-head">
        <div>
          <h2 id="forms-editor-title">${item ? 'Editar produto' : 'Novo produto'}</h2>
          <p class="muted">${
            item?.odoo_id
              ? `product.template · Odoo #${escapeHtml(item.odoo_id)}`
              : 'Altere um campo para salvar. O envio ao Odoo é automático.'
          }</p>
        </div>
        <div class="row">
          <button class="btn" type="submit" data-save hidden>Salvar</button>
          ${item?.id ? '<button class="btn-danger" type="button" data-delete>Excluir</button>' : ''}
          <button class="btn-ghost" type="button" data-close-modal>Fechar</button>
        </div>
      </div>
      ${entitySyncNoticeHtml(item)}
      <div class="grid-2">
        <label>Nome *<input name="name" required value="${escapeHtml(value.name || '')}" /></label>
        ${entityCombo('category', 'Categoria do produto', odooLabelPt(value.category || ''), 'Buscar categoria…')}
        <label>Preço de venda<input name="sales_price" value="${escapeHtml(value.sales_price || '')}" /></label>
        <label>Custo<input name="cost" value="${escapeHtml(value.cost || '')}" /></label>
        ${entityCombo('uom', 'Unidade de medida', odooLabelPt(value.uom || ''), 'Buscar unidade…')}
        <label>Referência interna<input name="internal_ref" value="${escapeHtml(value.internal_ref || '')}" /></label>
        <label>Peso (kg)<input name="weight" value="${escapeHtml(value.weight || '')}" placeholder="Peso de 1 unidade do produto (Odoo)" /></label>
        <label>Quantidade em mãos<input name="qty_on_hand" value="${escapeHtml(value.qty_on_hand || '')}" readonly placeholder="Via estoque Odoo" /></label>
        <label>Rastrear inventário
          <select name="track_inventory">
            <option value="True"${String(value.track_inventory || 'True') !== 'False' ? ' selected' : ''}>Sim</option>
            <option value="False"${String(value.track_inventory) === 'False' ? ' selected' : ''}>Não</option>
          </select>
        </label>
      </div>
    </form>`;

  openEditorModal(root);
  const form = editor.querySelector('#entity-form');
  bindEntityRefCombos(form, catalog.refs || {});
  bindEntityDirtySave(form);

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveBtn = form.querySelector('[data-save]');
    if (saveBtn?.hidden) return;
    const data = new FormData(form);
    const payload = Object.fromEntries(data.entries());
    try {
      const result = item?.id
        ? await api(`/api/forms/entities/products/${item.id}`, { method: 'PUT', body: payload })
        : await api('/api/forms/entities/products', { method: 'POST', body: payload });
      const savedId = result.item?.id || item?.id;
      closeEditorModal(root);
      await reload({ soft: true });
      if (savedId) void pollEntityProductSync(savedId, token);
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });

  editor.querySelector('[data-odoo-push]')?.addEventListener('click', async () => {
    try {
      await api(`/api/forms/entities/products/${item.id}/odoo-push`, {
        method: 'POST',
        body: {},
      });
      closeEditorModal(root);
      await reload({ soft: true });
      void pollEntityProductSync(item.id, token);
    } catch (error) {
      toast(`Odoo: ${formatSyncError(error.message || error)}`, { tone: 'error' });
    }
  });

  editor.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!confirm('Excluir este produto do Vertice? Ele será arquivado no Odoo.')) return;
    try {
      await api(`/api/forms/entities/products/${item.id}`, { method: 'DELETE' });
      toast('Excluído · arquivado no Odoo', { tone: 'subtle' });
      closeEditorModal(root);
      await reload({ soft: true });
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });
}

async function paintPartners(panel, root, reload, role, token, opts = {}) {
  const data = await api(`/api/forms/entities/partners?role=${encodeURIComponent(role)}`);
  if (!isNavActive(token)) return;
  const items = data.items || [];
  const title = role === 'customer' ? 'Clientes' : 'Fornecedores';
  const filtered = filterEntityItems(items, entityListFilter.q);
  const countLabel =
    filtered.length === items.length
      ? `${items.length} cadastro(s)`
      : `${filtered.length} de ${items.length} cadastro(s)`;

  const renderRows = (rows) => {
    if (!rows.length) {
      return items.length
        ? '<p class="muted">Nenhum cadastro corresponde à busca.</p>'
        : '<p class="muted">Nenhum cadastro. Use Configurações → Receber dados ou “Novo”.</p>';
    }
    return rows
      .map(
        (item) => `
        <button class="forms-list-item" type="button" data-edit-partner="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.name || 'Sem nome')}</strong>
          <span>${[
            item.is_company ? 'Empresa' : 'Pessoa',
            item.vat,
            item.email,
            item.phone,
            item.odoo_id ? `Odoo #${item.odoo_id}` : 'Local',
          ]
            .filter(Boolean)
            .map(escapeHtml)
            .join(' · ')}</span>
        </button>`,
      )
      .join('');
  };

  const bindRows = () => {
    panel.querySelectorAll('[data-edit-partner]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-edit-partner');
        const item = items.find((row) => row.id === id);
        panel.querySelectorAll('.forms-list-item.active').forEach((el) => el.classList.remove('active'));
        button.classList.add('active');
        openPartnerEditor(root, reload, role, item, token);
      });
    });
  };

  const bindSearch = () => {
    const input = panel.querySelector('#entities-filter-q');
    const count = panel.querySelector('#entities-list-count');
    const list = panel.querySelector('#entities-list');
    if (!input || input.dataset.boundSearch === '1') return;
    input.dataset.boundSearch = '1';
    input.addEventListener('input', () => {
      entityListFilter = { ...entityListFilter, q: input.value || '' };
      const next = filterEntityItems(items, entityListFilter.q);
      if (list) list.innerHTML = renderRows(next);
      if (count) {
        count.textContent =
          next.length === items.length
            ? `${items.length} cadastro(s)`
            : `${next.length} de ${items.length} cadastro(s)`;
      }
      bindRows();
    });
  };

  const existingList = panel.querySelector('#entities-list');
  const existingCount = panel.querySelector('#entities-list-count');
  if (opts.soft && existingList && existingCount) {
    existingList.innerHTML = renderRows(filtered);
    existingCount.textContent = countLabel;
    const oldInput = panel.querySelector('#entities-filter-q');
    if (oldInput) {
      const nextInput = oldInput.cloneNode(true);
      delete nextInput.dataset.boundSearch;
      oldInput.replaceWith(nextInput);
    }
    bindSearch();
    bindRows();
    return;
  }

  panel.innerHTML = `
    <div class="card-head forms-list-head">
      <div>
        <h2>${title}</h2>
        <p class="muted" id="entities-list-count">${escapeHtml(countLabel)}</p>
      </div>
    </div>
    <div class="forms-filters">
      <label class="forms-filter-search">
        <span class="sr-only">Buscar</span>
        <input type="search" id="entities-filter-q" placeholder="Buscar por nome, documento, e-mail…" value="${escapeHtml(entityListFilter.q)}" autocomplete="off" />
      </label>
    </div>
    <div class="forms-list" id="entities-list">${renderRows(filtered)}</div>`;

  bindSearch();
  bindRows();
}

function openPartnerEditor(root, reload, role, item, token) {
  const value = item || {
    id: '',
    name: '',
    is_customer: role === 'customer',
    is_vendor: role === 'vendor',
    email: '',
    phone: '',
    vat: '',
    street: '',
    city: '',
    is_company: true,
    odoo_id: '',
  };
  const isCompany = Boolean(value.is_company);
  const alsoOther =
    role === 'customer' ? Boolean(value.is_vendor) : Boolean(value.is_customer);
  const otherLabel = role === 'customer' ? 'Também é fornecedor' : 'Também é cliente';
  const roleLabel = role === 'customer' ? 'Cliente' : 'Fornecedor';

  ensureFormsModal(root);
  const editor = getFormsEditor(root);
  if (!editor) {
    toast('Não foi possível abrir o editor');
    return;
  }

  editor.innerHTML = `
    <form id="entity-form">
      <div class="card-head forms-editor-head">
        <div>
          <h2 id="forms-editor-title">${item ? `Editar ${roleLabel.toLowerCase()}` : `Novo ${roleLabel.toLowerCase()}`}</h2>
          <p class="muted">${
            item?.odoo_id
              ? `res.partner · Odoo #${escapeHtml(item.odoo_id)}`
              : 'Altere um campo para salvar. O envio ao Odoo é automático.'
          }</p>
        </div>
        <div class="row">
          <button class="btn" type="submit" data-save hidden>Salvar</button>
          ${item?.id ? '<button class="btn-danger" type="button" data-delete>Excluir</button>' : ''}
          <button class="btn-ghost" type="button" data-close-modal>Fechar</button>
        </div>
      </div>
      ${entitySyncNoticeHtml(item)}
      <fieldset class="forms-partner-type">
        <legend>Tipo de contato</legend>
        <label>
          <input type="radio" name="company_type" value="company" ${isCompany ? 'checked' : ''} />
          Empresa
        </label>
        <label>
          <input type="radio" name="company_type" value="person" ${!isCompany ? 'checked' : ''} />
          Indivíduo
        </label>
      </fieldset>
      <div class="grid-2">
        <label>Nome *
          <input name="name" required value="${escapeHtml(value.name || '')}" />
        </label>
        <label><span data-vat-label>${isCompany ? 'CNPJ' : 'CPF'} (VAT)</span>
          <input name="vat" value="${escapeHtml(value.vat || '')}" placeholder="documento fiscal" />
        </label>
        <label>E-mail
          <input name="email" type="email" value="${escapeHtml(value.email || '')}" />
        </label>
        <label>Telefone
          <input name="phone" value="${escapeHtml(value.phone || '')}" />
        </label>
        <label>Rua
          <input name="street" value="${escapeHtml(value.street || '')}" />
        </label>
        <label>Cidade
          <input name="city" value="${escapeHtml(value.city || '')}" />
        </label>
      </div>
      <label class="forms-partner-also">
        <input type="checkbox" name="also_other" ${alsoOther ? 'checked' : ''} />
        ${escapeHtml(otherLabel)}
      </label>
      ${
        item?.id && !item?.odoo_id
          ? '<div class="row forms-actions"><button class="btn-ghost" type="button" data-odoo-push>Tentar novamente</button></div>'
          : ''
      }
    </form>`;

  openEditorModal(root);
  const form = editor.querySelector('#entity-form');
  bindEntityDirtySave(form);

  editor.querySelectorAll('input[name="company_type"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const label = editor.querySelector('[data-vat-label]');
      if (label) label.textContent = `${radio.value === 'company' ? 'CNPJ' : 'CPF'} (VAT)`;
      form?._checkDirty?.();
    });
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveBtn = form.querySelector('[data-save]');
    if (saveBtn?.hidden) return;
    const companyType = form.querySelector('input[name="company_type"]:checked')?.value || 'company';
    const alsoOtherChecked = Boolean(form.also_other?.checked);
    const payload = {
      name: form.name.value,
      email: form.email.value,
      phone: form.phone.value,
      vat: form.vat.value,
      street: form.street.value,
      city: form.city.value,
      is_company: companyType === 'company',
      is_customer: role === 'customer' ? true : alsoOtherChecked,
      is_vendor: role === 'vendor' ? true : alsoOtherChecked,
    };
    try {
      const result = item?.id
        ? await api(`/api/forms/entities/partners/${item.id}`, { method: 'PUT', body: payload })
        : await api('/api/forms/entities/partners', { method: 'POST', body: payload });
      closeEditorModal(root);
      await reload({ soft: true });
      const savedId = result.item?.id || item?.id;
      if (savedId) void pollEntityPartnerSync(savedId, role, token);
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });

  editor.querySelector('[data-odoo-push]')?.addEventListener('click', async () => {
    try {
      await api(`/api/forms/entities/partners/${item.id}/odoo-push`, {
        method: 'POST',
        body: {},
      });
      closeEditorModal(root);
      await reload({ soft: true });
      void pollEntityPartnerSync(item.id, role, token);
    } catch (error) {
      toast(`Odoo: ${formatSyncError(error.message || error)}`, { tone: 'error' });
    }
  });

  editor.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!confirm('Excluir este cadastro do Vertice? Ele será arquivado no Odoo.')) return;
    try {
      await api(`/api/forms/entities/partners/${item.id}`, { method: 'DELETE' });
      toast('Excluído · arquivado no Odoo', { tone: 'subtle' });
      closeEditorModal(root);
      await reload({ soft: true });
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });
}
