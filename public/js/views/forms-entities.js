import { api } from '../api.js';
import { escapeHtml, formatSyncError, toast } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

function entitySyncNoticeHtml(item) {
  const err = String(item?.odoo_sync_error || '').trim();
  if (err) {
    return `<div class="forms-sync-notice is-error" role="alert" title="${escapeHtml(err)}">
      <span class="forms-sync-msg"><strong>Odoo · não sincronizado.</strong> ${escapeHtml(formatSyncError(err, 420))}</span>
      ${item?.id ? '<button class="btn-ghost" type="button" data-odoo-push>Tentar novamente</button>' : ''}
    </div>`;
  }
  if (item?.odoo_id) {
    return `<div class="forms-sync-notice" role="status">
      <span class="forms-sync-msg">Odoo #${escapeHtml(item.odoo_id)} · sync automático ao salvar</span>
    </div>`;
  }
  return `<div class="forms-sync-notice is-pending" role="status">
    <span class="forms-sync-msg">Salvar envia automaticamente ao Odoo</span>
  </div>`;
}

async function pollEntityProductSync(productId, reload, token, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (!isNavActive(token)) return;
    try {
      const detail = await api(`/api/forms/${encodeURIComponent(productId)}`);
      const header = detail.item?.header || {};
      if (header.odoo_sync_pending === '1') continue;
      const err = String(header.odoo_sync_error || '').trim();
      if (err) toast(`Odoo: ${formatSyncError(err, 220)}`, { tone: 'error' });
      else if (header.odoo_id) toast(`Sincronizado com Odoo #${header.odoo_id}`, { tone: 'subtle' });
      await reload();
      return;
    } catch {
      return;
    }
  }
  if (isNavActive(token)) await reload();
}

const ENTITY_TABS = [
  { id: 'produtos', label: 'Produtos' },
  { id: 'clientes', label: 'Clientes' },
  { id: 'fornecedores', label: 'Fornecedores' },
];

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
  const summary = await api('/api/forms/entities/summary').catch(() => ({
    products: 0,
    customers: 0,
    vendors: 0,
  }));
  if (!isNavActive(token)) return;

  body.innerHTML = `
    <div class="forms-catalog-bar muted">
      Cadastros Odoo: <strong>${summary.products || 0}</strong> produtos ·
      <strong>${summary.customers || 0}</strong> clientes ·
      <strong>${summary.vendors || 0}</strong> fornecedores
      · salvar localmente e enviar ao Odoo quando quiser
    </div>
    <nav class="settings-tabs forms-tabs" aria-label="Tipos de cadastro">
      ${ENTITY_TABS.map(
        (tab) =>
          `<a class="settings-tab${tab.id === entity ? ' active' : ''}" href="#/forms/cadastros/${tab.id}">${escapeHtml(tab.label)}</a>`,
      ).join('')}
    </nav>
    <div id="entities-panel" class="card forms-editor-card" style="padding:16px;"></div>
    <button type="button" hidden data-entities-new></button>`;

  const panel = body.querySelector('#entities-panel');
  const reload = () => renderEntitiesBody(body, entity, token, root);

  body.querySelector('[data-entities-new]')?.addEventListener('click', () => {
    if (entity === 'produtos') openProductEditor(panel, reload, null, token);
    else openPartnerEditor(panel, reload, entity === 'clientes' ? 'customer' : 'vendor', null, token);
  });

  if (entity === 'produtos') await paintProducts(panel, reload, token);
  else await paintPartners(panel, reload, entity === 'clientes' ? 'customer' : 'vendor', token);
}

async function paintProducts(panel, reload, token) {
  const data = await api('/api/forms/entities/products');
  if (!isNavActive(token)) return;
  const items = data.items || [];
  panel.innerHTML = `
    <div class="card-head">
      <h2>Produtos</h2>
      <p class="muted">${items.length} cadastro(s) · espelho de product.template</p>
    </div>
    <div class="forms-list" style="max-height:none;">
      ${
        items.length
          ? items
              .map(
                (item) => `
        <button class="forms-list-item" type="button" data-edit-product="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.name || 'Sem nome')}</strong>
          <span>${escapeHtml(
            [
              item.internal_ref,
              item.category,
              item.uom,
              item.sales_price && `venda ${item.sales_price}`,
              item.odoo_id && `Odoo #${item.odoo_id}`,
            ]
              .filter(Boolean)
              .join(' · ') || 'Sem detalhes',
          )}</span>
        </button>`,
              )
              .join('')
          : '<p class="muted">Nenhum produto. Use Configurações → Receber dados ou “Novo”.</p>'
      }
    </div>`;

  panel.querySelectorAll('[data-edit-product]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-edit-product');
      const item = items.find((row) => row.id === id);
      openProductEditor(panel, reload, item, token);
    });
  });
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
    const close = () => {
      menu.hidden = true;
      menu.innerHTML = '';
      wrap.classList.remove('is-open');
    };
    const paint = (query) => {
      const q = String(query || '')
        .trim()
        .toLowerCase();
      const matches = (q ? items.filter((item) => item.name.toLowerCase().includes(q)) : items).slice(0, 12);
      if (!matches.length) {
        menu.innerHTML = '<div class="forms-combo-empty">Nenhuma opção Odoo (Receber dados)</div>';
        menu.hidden = false;
        wrap.classList.add('is-open');
        return;
      }
      menu.innerHTML = matches
        .map(
          (item) =>
            `<button type="button" class="forms-combo-option" data-combo-pick="${escapeHtml(item.name)}">
              <strong>${escapeHtml(item.name)}</strong>
              ${item.odoo_id ? `<span>Odoo #${escapeHtml(item.odoo_id)}</span>` : ''}
            </button>`,
        )
        .join('');
      menu.hidden = false;
      wrap.classList.add('is-open');
      menu.querySelectorAll('[data-combo-pick]').forEach((btn) => {
        btn.addEventListener('mousedown', (event) => {
          event.preventDefault();
          input.value = btn.getAttribute('data-combo-pick') || '';
          close();
        });
      });
    };
    input.addEventListener('focus', () => paint(input.value));
    input.addEventListener('input', () => paint(input.value));
    input.addEventListener('blur', () => window.setTimeout(close, 120));
  });
}

async function openProductEditor(panel, reload, item, token) {
  const value = item || {
    id: '',
    name: '',
    category: '',
    sales_price: '',
    cost: '',
    uom: '',
    internal_ref: '',
    qty_on_hand: '',
    track_inventory: 'True',
    odoo_id: '',
  };
  const catalog = await api('/api/forms/catalog').catch(() => ({ refs: {} }));
  if (!isNavActive(token)) return;
  panel.innerHTML = `
    <form id="entity-form">
      <div class="card-head forms-editor-head">
        <div>
          <h2>${item ? 'Editar produto' : 'Novo produto'}</h2>
          <p class="muted">${
            item?.odoo_id
              ? `product.template · Odoo #${escapeHtml(item.odoo_id)}`
              : 'product.template · ainda só no Vertice'
          }</p>
        </div>
        <button class="btn-ghost" type="button" data-back>Voltar</button>
      </div>
      <div class="grid-2">
        <label>Nome *<input name="name" required value="${escapeHtml(value.name || '')}" /></label>
        ${entityCombo('category', 'Categoria do produto', value.category, 'Buscar categoria…')}
        <label>Preço de venda<input name="sales_price" value="${escapeHtml(value.sales_price || '')}" /></label>
        <label>Custo<input name="cost" value="${escapeHtml(value.cost || '')}" /></label>
        ${entityCombo('uom', 'Unidade de medida', value.uom, 'Buscar unidade…')}
        <label>Referência interna<input name="internal_ref" value="${escapeHtml(value.internal_ref || '')}" /></label>
        <label>Quantidade em mãos<input name="qty_on_hand" value="${escapeHtml(value.qty_on_hand || '')}" readonly placeholder="Via estoque Odoo" /></label>
        <label>Rastrear inventário
          <select name="track_inventory">
            <option value="True"${String(value.track_inventory || 'True') !== 'False' ? ' selected' : ''}>Sim</option>
            <option value="False"${String(value.track_inventory) === 'False' ? ' selected' : ''}>Não</option>
          </select>
        </label>
      </div>
      ${entitySyncNoticeHtml(item)}
      <div class="row forms-actions">
        <button class="btn" type="submit">Salvar</button>
        ${item?.id ? '<button class="btn-danger" type="button" data-delete>Excluir</button>' : ''}
      </div>
    </form>`;

  const form = panel.querySelector('#entity-form');
  bindEntityRefCombos(form, catalog.refs || {});
  panel.querySelector('[data-back]')?.addEventListener('click', () => paintProducts(panel, reload, token));
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = Object.fromEntries(data.entries());
    try {
      const result = item?.id
        ? await api(`/api/forms/entities/products/${item.id}`, { method: 'PUT', body: payload })
        : await api('/api/forms/entities/products', { method: 'POST', body: payload });
      const savedId = result.item?.id || item?.id;
      toast('Produto salvo · sincronizando com Odoo…', { tone: 'subtle' });
      await reload();
      if (savedId) void pollEntityProductSync(savedId, reload, token);
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });
  panel.querySelector('[data-odoo-push]')?.addEventListener('click', async () => {
    try {
      const result = await api(`/api/forms/entities/products/${item.id}/odoo-push`, {
        method: 'POST',
        body: {},
      });
      const odooId = result.item?.header?.odoo_id || result.item?.odoo_id || '';
      toast(odooId ? `Enviado ao Odoo #${odooId}` : 'Enviado ao Odoo', { tone: 'subtle' });
      await reload();
    } catch (error) {
      toast(`Odoo: ${formatSyncError(error.message || error)}`, { tone: 'error' });
      await reload();
    }
  });
  panel.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!confirm('Excluir este produto do Vertice? Ele será arquivado no Odoo.')) return;
    try {
      await api(`/api/forms/entities/products/${item.id}`, { method: 'DELETE' });
      toast('Excluído · arquivado no Odoo', { tone: 'subtle' });
      await reload();
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });
}

async function paintPartners(panel, reload, role, token) {
  const data = await api(`/api/forms/entities/partners?role=${encodeURIComponent(role)}`);
  if (!isNavActive(token)) return;
  const items = data.items || [];
  const title = role === 'customer' ? 'Clientes' : 'Fornecedores';
  panel.innerHTML = `
    <div class="card-head">
      <h2>${title}</h2>
      <p class="muted">${items.length} cadastro(s) · espelho de res.partner</p>
    </div>
    <div class="forms-list" style="max-height:none;">
      ${
        items.length
          ? items
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
              .join('')
          : `<p class="muted">Nenhum cadastro. Use Configurações → Receber dados ou “Novo”.</p>`
      }
    </div>`;

  panel.querySelectorAll('[data-edit-partner]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-edit-partner');
      const item = items.find((row) => row.id === id);
      openPartnerEditor(panel, reload, role, item, token);
    });
  });
}

function openPartnerEditor(panel, reload, role, item, token) {
  // Como no Odoo: o menu (Clientes/Fornecedores) define o papel; is_company é Indivíduo/Empresa.
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

  panel.innerHTML = `
    <form id="entity-form">
      <div class="card-head forms-editor-head">
        <div>
          <h2>${item ? `Editar ${roleLabel.toLowerCase()}` : `Novo ${roleLabel.toLowerCase()}`}</h2>
          <p class="muted">${
            item?.odoo_id
              ? `res.partner · Odoo #${escapeHtml(item.odoo_id)}`
              : 'res.partner · ainda só no Vertice'
          }</p>
        </div>
        <button class="btn-ghost" type="button" data-back>Voltar</button>
      </div>
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
      <p class="muted" style="margin:8px 0 0;font-size:0.82rem;">
        No Odoo o papel principal vem do menu (${escapeHtml(roleLabel)}). Cliente/fornecedor não são mais checkboxes fixos na ficha.
      </p>
      ${
        item?.odoo_id
          ? entitySyncNoticeHtml(item)
          : `<div class="forms-sync-notice is-pending" role="status">
              <span class="forms-sync-msg">Salvar envia automaticamente ao Odoo</span>
            </div>`
      }
      <div class="row forms-actions">
        <button class="btn" type="submit">Salvar</button>
        ${item?.id && !item?.odoo_id ? '<button class="btn-ghost" type="button" data-odoo-push>Tentar novamente</button>' : ''}
        ${item?.id ? '<button class="btn-danger" type="button" data-delete>Excluir</button>' : ''}
      </div>
    </form>`;

  panel.querySelector('[data-back]')?.addEventListener('click', () => paintPartners(panel, reload, role, token));
  panel.querySelectorAll('input[name="company_type"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const label = panel.querySelector('[data-vat-label]');
      if (label) label.textContent = `${radio.value === 'company' ? 'CNPJ' : 'CPF'} (VAT)`;
    });
  });
  panel.querySelector('#entity-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
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
      // Papel principal = aba atual (igual menu Odoo); o outro só se marcado.
      is_customer: role === 'customer' ? true : alsoOtherChecked,
      is_vendor: role === 'vendor' ? true : alsoOtherChecked,
    };
    try {
      const result = item?.id
        ? await api(`/api/forms/entities/partners/${item.id}`, { method: 'PUT', body: payload })
        : await api('/api/forms/entities/partners', { method: 'POST', body: payload });
      toast('Cadastro salvo · sincronizando com Odoo…', { tone: 'subtle' });
      await reload();
      const savedId = result.item?.id || item?.id;
      if (savedId) {
        setTimeout(async () => {
          if (!isNavActive(token)) return;
          try {
            const list = await api('/api/forms/entities/partners?role=all');
            const found = (list.items || []).find((row) => row.id === savedId);
            if (found?.odoo_id) {
              toast(`Sincronizado com Odoo #${found.odoo_id}`, { tone: 'subtle' });
            }
            await reload();
          } catch (error) {
            toast(`Odoo: ${formatSyncError(error.message || error)}`, { tone: 'error' });
          }
        }, 2500);
      }
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });
  panel.querySelector('[data-odoo-push]')?.addEventListener('click', async () => {
    try {
      const result = await api(`/api/forms/entities/partners/${item.id}/odoo-push`, {
        method: 'POST',
        body: {},
      });
      toast(`Enviado ao Odoo #${result.item?.odoo_id || ''}`, { tone: 'subtle' });
      await reload();
    } catch (error) {
      toast(`Odoo: ${formatSyncError(error.message || error)}`, { tone: 'error' });
    }
  });
  panel.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!confirm('Excluir este cadastro do Vertice? Ele será arquivado no Odoo.')) return;
    try {
      await api(`/api/forms/entities/partners/${item.id}`, { method: 'DELETE' });
      toast('Excluído · arquivado no Odoo', { tone: 'subtle' });
      await reload();
    } catch (error) {
      toast(formatSyncError(error.message || error), { tone: 'error' });
    }
  });
}
