import { escapeHtml, toast } from './ui.js';
import { initTheme, toggleTheme } from './theme.js';

initTheme();

const app = document.querySelector('#app');
const token = location.pathname.split('/').filter(Boolean).pop() || '';

boot().catch((error) => {
  app.innerHTML = `<main class="forms-public"><div class="forms-public-card"><h1>Link indisponível</h1><p class="muted">${escapeHtml(error.message)}</p></div></main>`;
});

async function boot() {
  if (!token) throw new Error('Token ausente');
  const data = await publicApi(`/api/forms/public/${encodeURIComponent(token)}`);
  render(data);
}

function render(data) {
  const { item, fields, kindLabel, catalog = { products: [], partners: [] } } = data;
  const kind = item.kind;
  const hasLines = (fields.lines || []).length > 0;
  const customers = (catalog.partners || []).filter((p) => p.is_customer);
  const vendors = (catalog.partners || []).filter((p) => p.is_vendor);
  const products = catalog.products || [];

  app.innerHTML = `
    <main class="forms-public">
      <div class="forms-public-card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <p class="kicker">Vertice Forms · ${escapeHtml(kindLabel || '')}</p>
            <h1>Preenchimento externo</h1>
            <p class="muted">Sugestões do catálogo compartilhado. Salve quando terminar.</p>
          </div>
          <button class="icon-btn theme-toggle" type="button" data-theme-toggle aria-label="Alternar tema">
            <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
            <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5Z"/></svg>
          </button>
        </div>
        <form id="public-form" data-kind="${escapeHtml(kind)}">
          <datalist id="forms-products">${products.map((p) => `<option value="${escapeHtml(p.name)}"></option>`).join('')}</datalist>
          <datalist id="forms-customers">${customers.map((p) => `<option value="${escapeHtml(p.name)}"></option>`).join('')}</datalist>
          <datalist id="forms-vendors">${vendors.map((p) => `<option value="${escapeHtml(p.name)}"></option>`).join('')}</datalist>
          <label>Título
            <input name="title" value="${escapeHtml(item.title || '')}" />
          </label>
          <div class="forms-section">
            <h2>Dados principais</h2>
            <div class="grid-2">
              ${(fields.header || [])
                .map((field) => {
                  const list =
                    field.key === 'customer'
                      ? ' list="forms-customers"'
                      : field.key === 'vendor'
                        ? ' list="forms-vendors"'
                        : field.key === 'name'
                          ? ' list="forms-products"'
                          : '';
                  return `
                <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}
                  <input name="h_${escapeHtml(field.key)}" value="${escapeHtml(item.header?.[field.key] || '')}" placeholder="${escapeHtml(field.placeholder || '')}"${list} />
                </label>`;
                })
                .join('')}
            </div>
          </div>
          ${
            hasLines
              ? `<div class="forms-section">
                  <div class="row forms-lines-head">
                    <h2>Linhas de produto</h2>
                    <button class="btn-ghost" type="button" id="add-line">Adicionar linha</button>
                  </div>
                  <div id="lines">${(item.lines || []).map((line, index) => lineBlock(line, fields.lines, index, kind)).join('')}</div>
                </div>`
              : ''
          }
          <div class="row forms-actions">
            <button class="btn" type="submit">Salvar</button>
          </div>
          <p class="muted" id="save-msg"></p>
        </form>
      </div>
    </main>`;

  document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => toggleTheme());

  const form = document.querySelector('#public-form');
  document.querySelector('#add-line')?.addEventListener('click', () => {
    const box = document.querySelector('#lines');
    const index = box.querySelectorAll('.forms-line').length;
    box.insertAdjacentHTML('beforeend', lineBlock({ id: '', values: {} }, fields.lines, index, kind));
    bindRemoves();
    bindAutofill(form, products);
  });
  bindRemoves();
  bindAutofill(form, products);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const payload = collect(form, fields);
      await publicApi(`/api/forms/public/${encodeURIComponent(token)}`, {
        method: 'PUT',
        body: payload,
      });
      document.querySelector('#save-msg').textContent = 'Salvo com sucesso. Catálogo atualizado.';
      toast('Salvo');
    } catch (error) {
      document.querySelector('#save-msg').textContent = error.message;
      toast(error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

function lineBlock(line, lineFields, index, kind) {
  return `
    <div class="forms-line" data-line-id="${escapeHtml(line.id || '')}">
      <div class="forms-line-top">
        <strong>Item ${index + 1}</strong>
        <button class="btn-ghost" type="button" data-remove-line>Remover</button>
      </div>
      <div class="grid-2">
        ${lineFields
          .map((field) => {
            const list = field.key === 'product' ? ' list="forms-products"' : '';
            const productAttr = field.key === 'product' ? ' data-product-input="1"' : '';
            return `
          <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}
            <input data-line-key="${escapeHtml(field.key)}" value="${escapeHtml(line.values?.[field.key] || '')}"${list}${productAttr} data-price-kind="${escapeHtml(kind)}" />
          </label>`;
          })
          .join('')}
      </div>
    </div>`;
}

function bindRemoves() {
  document.querySelectorAll('[data-remove-line]').forEach((button) => {
    button.onclick = () => button.closest('.forms-line')?.remove();
  });
}

function bindAutofill(form, products) {
  form.querySelectorAll('[data-product-input]').forEach((input) => {
    if (input.dataset.boundCatalog === '1') return;
    input.dataset.boundCatalog = '1';
    input.addEventListener('change', () => {
      const match = products.find(
        (item) => item.name.trim().toLowerCase() === String(input.value || '').trim().toLowerCase(),
      );
      if (!match) return;
      const price = input.closest('.forms-line')?.querySelector('[data-line-key="unit_price"]');
      if (!price || price.value.trim()) return;
      const kind = input.getAttribute('data-price-kind');
      price.value = kind === 'purchase' ? match.cost || match.sales_price || '' : match.sales_price || match.cost || '';
    });
  });
}

function collect(form, fields) {
  const data = new FormData(form);
  const header = {};
  for (const field of fields.header || []) {
    header[field.key] = String(data.get(`h_${field.key}`) || '');
  }
  const lines = [...form.querySelectorAll('.forms-line')].map((node) => {
    const values = {};
    node.querySelectorAll('[data-line-key]').forEach((input) => {
      values[input.getAttribute('data-line-key')] = input.value || '';
    });
    return { id: node.getAttribute('data-line-id') || undefined, values };
  });
  return {
    title: String(data.get('title') || ''),
    header,
    lines: (fields.lines || []).length ? lines : undefined,
  };
}

async function publicApi(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir');
  return data;
}
