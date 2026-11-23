import { api } from '../api.js';
import { escapeHtml, toast } from '../ui.js';

const UF = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
];

let settings = { producers: [], deliveryPoints: [] };
let editor = null;

function ha(value) {
  if (value == null || value === '') return '—';
  return `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ha`;
}

function place(city, state) {
  const parts = [city, state].filter(Boolean);
  return parts.length ? parts.join(' / ') : '—';
}

function option(value, label, selected) {
  const mark = String(value) === String(selected) ? 'selected' : '';
  return `<option value="${escapeHtml(value)}" ${mark}>${escapeHtml(label)}</option>`;
}

function actions(extra = '') {
  return `
    <div class="agro-form-actions">
      <button class="btn" type="submit">Salvar</button>
      <button class="btn-ghost" type="button" data-close-modal>Cancelar</button>
      ${extra}
    </div>`;
}

function removeButton() {
  return `<button class="btn-danger" type="button" data-delete-modal>Excluir</button>`;
}

function producerForm(item) {
  return `
    <header class="forms-editor-head">
      <div>
        <h2 id="agro-editor-title">${item?.id ? 'Editar produtor' : 'Novo produtor'}</h2>
        <p class="muted">Cadastro central do produtor. O celular fica disponível para o Vertice Bot.</p>
      </div>
    </header>
    <form id="agro-settings-form" class="agro-form" data-kind="producer">
      <label>Nome do produtor
        <input name="name" maxlength="150" required value="${escapeHtml(item?.name || '')}">
      </label>
      <div class="grid-2">
        <label>Área total da propriedade (ha)
          <input name="totalArea" inputmode="decimal" value="${escapeHtml(item?.totalArea ?? '')}">
        </label>
        <label>Contato (celular)
          <input name="phone" type="tel" maxlength="20" placeholder="ex.: 44999998888" value="${escapeHtml(item?.phone || '')}">
        </label>
      </div>
      <div class="grid-2">
        <label>Município
          <input name="city" maxlength="120" value="${escapeHtml(item?.city || '')}">
        </label>
        <label>Estado (UF)
          <select name="state">
            ${option('', 'Selecione', item?.state || '')}
            ${UF.map((uf) => option(uf, uf, item?.state || '')).join('')}
          </select>
        </label>
      </div>
      ${actions(item?.id ? removeButton() : '')}
    </form>`;
}

function propertyForm(item, producerId) {
  const producers = settings.producers || [];
  const selected = item?.producerId || producerId || '';
  return `
    <header class="forms-editor-head">
      <div>
        <h2 id="agro-editor-title">${item?.id ? 'Editar propriedade' : 'Nova propriedade'}</h2>
        <p class="muted">Cada produtor pode ter várias propriedades. Os talhões ficam dentro da propriedade.</p>
      </div>
    </header>
    <form id="agro-settings-form" class="agro-form" data-kind="property">
      <label>Produtor
        <select name="producerId" required>
          ${option('', 'Selecione', selected)}
          ${producers.map((producer) => option(producer.id, producer.name, selected)).join('')}
        </select>
      </label>
      <label>Nome da propriedade
        <input name="name" maxlength="150" required value="${escapeHtml(item?.name || '')}">
      </label>
      ${actions(item?.id ? removeButton() : '')}
    </form>`;
}

function plotLabel(plot) {
  const code = String(plot?.code || '').trim();
  const name = String(plot?.name || '').trim();
  if (code && name && code.toLowerCase() !== name.toLowerCase()) return `${code} · ${name}`;
  return code || name || '—';
}

function deliveryPointForm(item) {
  return `
    <header class="forms-editor-head">
      <div>
        <h2 id="agro-editor-title">${item?.id ? 'Editar local de entrega' : 'Novo local de entrega'}</h2>
        <p class="muted">Pontos curtos usados na entrega e no Bot (ex.: Sacolão, Escola Municipal).</p>
      </div>
    </header>
    <form id="agro-settings-form" class="agro-form" data-kind="deliveryPoint">
      <label>Nome do local
        <input name="name" maxlength="150" required placeholder="ex.: Sacolão" value="${escapeHtml(item?.name || '')}">
      </label>
      ${actions(item?.id ? removeButton() : '')}
    </form>`;
}

function plotForm(item, propertyId) {
  const properties = (settings.producers || []).flatMap((producer) =>
    (producer.properties || []).map((property) => ({
      ...property,
      label: `${producer.name} · ${property.name}`,
    })),
  );
  const selected = item?.propertyId || propertyId || '';
  const code = String(item?.code || '').trim();
  return `
    <header class="forms-editor-head">
      <div>
        <h2 id="agro-editor-title">${item?.id ? 'Editar talhão' : 'Novo talhão'}</h2>
        <p class="muted">O código (ex.: 1 ou A1) é o que o Bot e as listas usam. O nome descreve a área.</p>
      </div>
    </header>
    <form id="agro-settings-form" class="agro-form" data-kind="plot">
      <label>Propriedade
        <select name="propertyId" required>
          ${option('', 'Selecione', selected)}
          ${properties.map((property) => option(property.id, property.label, selected)).join('')}
        </select>
      </label>
      <label>Código do talhão <span class="muted">(obrigatório · Bot)</span>
        <input name="code" maxlength="40" required autocomplete="off" placeholder="ex.: 1 ou A1" value="${escapeHtml(code)}">
      </label>
      <label>Nome do talhão
        <input name="name" maxlength="150" required placeholder="ex.: Hortaliças, Fruticultura, Leite" value="${escapeHtml(item?.name || '')}">
      </label>
      <label>Área (ha)
        <input name="area" inputmode="decimal" value="${escapeHtml(item?.area ?? '')}">
      </label>
      ${actions(item?.id ? removeButton() : '')}
    </form>`;
}

function ensureModal() {
  let modal = document.getElementById('agro-modal');
  if (modal) return modal;
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="forms-modal" id="agro-modal" hidden>
      <div class="forms-modal-backdrop" data-close-modal tabindex="-1"></div>
      <section class="card forms-editor-card forms-modal-dialog" id="agro-editor" role="dialog" aria-modal="true" aria-labelledby="agro-editor-title"></section>
    </div>`,
  );
  return document.getElementById('agro-modal');
}

function closeModal() {
  const modal = document.getElementById('agro-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('is-open');
  document.body.classList.remove('agro-modal-open');
  editor = null;
}

function openModal(kind, record, context = {}) {
  const modal = ensureModal();
  const html =
    kind === 'property'
      ? propertyForm(record, context.producerId)
      : kind === 'plot'
        ? plotForm(record, context.propertyId)
        : kind === 'deliveryPoint'
          ? deliveryPointForm(record)
          : producerForm(record);
  modal.querySelector('#agro-editor').innerHTML = html;
  editor = { kind, id: record?.id || '', context };
  modal.hidden = false;
  modal.classList.add('is-open');
  document.body.classList.add('agro-modal-open');
}

function readForm(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    data[key] = String(value);
  });
  return data;
}

function findProducer(id) {
  return (settings.producers || []).find((item) => item.id === id);
}

function findProperty(id) {
  for (const producer of settings.producers || []) {
    const property = (producer.properties || []).find((item) => item.id === id);
    if (property) return { ...property, producerId: producer.id };
  }
  return null;
}

function findPlot(id) {
  for (const producer of settings.producers || []) {
    for (const property of producer.properties || []) {
      const plot = (property.plots || []).find((item) => item.id === id);
      if (plot) return { ...plot, propertyId: property.id };
    }
  }
  return null;
}

function findDeliveryPoint(id) {
  return (settings.deliveryPoints || []).find((item) => item.id === id) || null;
}

async function reload(root) {
  settings = await api('/api/agro/settings');
  paint(root);
}

function deliveryPointsCard() {
  const points = settings.deliveryPoints || [];
  return `
    <section class="card agro-settings">
      <div class="agro-settings-head">
        <div>
          <h2 class="section-title">Locais de entrega</h2>
          <p class="muted">Lista curta para a entrega e o Bot (Sacolão, escolas, Coara…). No Odoo, cada local precisa de CNPJ/CPF, endereço e dados fiscais para emitir NF.</p>
        </div>
        <button class="btn agro-mini" type="button" data-settings-new="deliveryPoint">Novo local</button>
      </div>
      ${
        points.length
          ? `<ul class="agro-plot-list">${points
              .map(
                (point) => `<li>
                  <span>${escapeHtml(point.name)}</span>
                  <span class="agro-actions">
                    <button class="btn-ghost agro-mini" type="button" data-settings-edit="deliveryPoint" data-id="${escapeHtml(point.id)}">Editar</button>
                    <button class="btn-ghost agro-mini" type="button" data-settings-delete="deliveryPoint" data-id="${escapeHtml(point.id)}">Excluir</button>
                  </span>
                </li>`,
              )
              .join('')}</ul>`
          : `<p class="muted">Nenhum local cadastrado.</p>`
      }
    </section>`;
}

function paint(root) {
  const body = root.querySelector('#agro-body');
  if (!body) return;
  const producers = settings.producers || [];
  body.innerHTML = `
    ${deliveryPointsCard()}
    <section class="card agro-settings">
      <div class="agro-settings-head">
        <div>
          <h2 class="section-title">Produtores e propriedades</h2>
          <p class="muted">1) Novo produtor · 2) Nova propriedade · 3) Novo talhão dentro da propriedade.</p>
        </div>
      </div>
      ${
        producers.length
          ? producers.map((producer) => producerCard(producer)).join('')
          : `<p class="muted">Nenhum produtor ainda. Use <strong>Novo produtor</strong> no topo; em seguida <strong>Nova propriedade</strong>.</p>`
      }
    </section>`;
}

function producerCard(producer) {
  const properties = producer.properties || [];
  return `
    <article class="agro-producer-card" data-search="${escapeHtml(`${producer.name} ${producer.city} ${producer.state} ${producer.phone}`.toLowerCase())}">
      <header class="agro-producer-head">
        <div>
          <h3>${escapeHtml(producer.name)}</h3>
          <p class="agro-sub">${escapeHtml(place(producer.city, producer.state))} · Área total ${ha(producer.totalArea)} · Contato ${escapeHtml(producer.phone || '—')}</p>
        </div>
        <div class="agro-actions">
          <button class="btn agro-mini" type="button" data-settings-new="property" data-producer="${escapeHtml(producer.id)}">Nova propriedade</button>
          <button class="btn-ghost agro-mini" type="button" data-settings-edit="producer" data-id="${escapeHtml(producer.id)}">Editar</button>
          <button class="btn-ghost agro-mini" type="button" data-settings-delete="producer" data-id="${escapeHtml(producer.id)}">Excluir</button>
        </div>
      </header>
      ${
        properties.length
          ? `<div class="agro-property-list">${properties.map((property) => propertyBlock(property)).join('')}</div>`
          : `<div class="agro-empty-cta agro-empty-cta--inline">
              <p class="muted">Este produtor ainda não tem propriedade.</p>
              <button class="btn-ghost agro-mini" type="button" data-settings-new="property" data-producer="${escapeHtml(producer.id)}">Cadastrar propriedade</button>
            </div>`
      }
    </article>`;
}

function propertyBlock(property) {
  const plots = property.plots || [];
  return `
    <div class="agro-property-block">
      <div class="agro-property-head">
        <strong>${escapeHtml(property.name)}</strong>
        <div class="agro-actions">
          <button class="btn agro-mini" type="button" data-settings-new="plot" data-property="${escapeHtml(property.id)}">Novo talhão</button>
          <button class="btn-ghost agro-mini" type="button" data-settings-edit="property" data-id="${escapeHtml(property.id)}">Editar</button>
          <button class="btn-ghost agro-mini" type="button" data-settings-delete="property" data-id="${escapeHtml(property.id)}">Excluir</button>
        </div>
      </div>
      ${
        plots.length
          ? `<ul class="agro-plot-list">${plots
              .map(
                (plot) => `<li>
                  <span>${escapeHtml(plotLabel(plot))}<span class="agro-sub">${ha(plot.area)}</span></span>
                  <span class="agro-actions">
                    <button class="btn-ghost agro-mini" type="button" data-settings-edit="plot" data-id="${escapeHtml(plot.id)}">Editar</button>
                    <button class="btn-ghost agro-mini" type="button" data-settings-delete="plot" data-id="${escapeHtml(plot.id)}">Excluir</button>
                  </span>
                </li>`,
              )
              .join('')}</ul>`
          : `<div class="agro-empty-cta agro-empty-cta--inline">
              <p class="muted">Sem talhões nesta propriedade.</p>
              <button class="btn-ghost agro-mini" type="button" data-settings-new="plot" data-property="${escapeHtml(property.id)}">Cadastrar talhão</button>
            </div>`
      }
    </div>`;
}

async function saveForm(form) {
  if (!editor) return;
  const data = readForm(form);
  const paths = {
    producer: editor.id ? `/api/agro/producers/${editor.id}` : '/api/agro/producers',
    property: editor.id ? `/api/agro/properties/${editor.id}` : '/api/agro/properties',
    plot: editor.id ? `/api/agro/plots/${editor.id}` : '/api/agro/plots',
    deliveryPoint: editor.id
      ? `/api/agro/delivery-points/${editor.id}`
      : '/api/agro/delivery-points',
  };
  await api(paths[editor.kind], { method: 'POST', body: data });
}

async function removeCurrent() {
  if (!editor?.id) return;
  const labels = {
    producer: 'produtor',
    property: 'propriedade',
    plot: 'talhão',
    deliveryPoint: 'local de entrega',
  };
  if (!confirm(`Excluir este ${labels[editor.kind]}?`)) return;
  const paths = {
    producer: `/api/agro/producers/${editor.id}`,
    property: `/api/agro/properties/${editor.id}`,
    plot: `/api/agro/plots/${editor.id}`,
    deliveryPoint: `/api/agro/delivery-points/${editor.id}`,
  };
  await api(paths[editor.kind], { method: 'DELETE' });
}

function bindModal(root) {
  const modal = ensureModal();
  if (modal.dataset.agroSettingsBound === '1') return;
  modal.dataset.agroSettingsBound = '1';
  modal.addEventListener('click', async (event) => {
    if (event.target.closest('[data-close-modal]')) {
      closeModal();
      return;
    }
    if (!event.target.closest('[data-delete-modal]') || !editor) return;
    event.preventDefault();
    try {
      await removeCurrent();
      closeModal();
      toast('Registro excluído');
      await reload(root);
    } catch (error) {
      toast(error.message || 'Não foi possível excluir', { tone: 'error' });
    }
  });
  modal.addEventListener('submit', async (event) => {
    const form = event.target;
    if (form?.id !== 'agro-settings-form' || !editor) return;
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await saveForm(form);
      closeModal();
      toast('Registro salvo');
      await reload(root);
    } catch (error) {
      toast(error.message || 'Não foi possível salvar', { tone: 'error' });
      button.disabled = false;
    }
  });
}

function bind(root) {
  if (root.dataset.agroSettingsUi === '1') return;
  root.dataset.agroSettingsUi = '1';
  root.addEventListener('click', async (event) => {
    const create = event.target.closest('[data-settings-new]');
    if (create) {
      const kind = create.dataset.settingsNew;
      if (kind === 'property' && !(settings.producers || []).length) {
        toast('Cadastre um produtor antes da propriedade', { tone: 'error' });
        openModal('producer', null);
        return;
      }
      if (kind === 'plot' && !(settings.producers || []).some((item) => (item.properties || []).length)) {
        toast('Cadastre uma propriedade antes do talhão', { tone: 'error' });
        return;
      }
      openModal(kind, null, {
        producerId: create.dataset.producer || '',
        propertyId: create.dataset.property || '',
      });
      return;
    }
    const edit = event.target.closest('[data-settings-edit]');
    if (edit) {
      const kind = edit.dataset.settingsEdit;
      const record =
        kind === 'property'
          ? findProperty(edit.dataset.id)
          : kind === 'plot'
            ? findPlot(edit.dataset.id)
            : kind === 'deliveryPoint'
              ? findDeliveryPoint(edit.dataset.id)
              : findProducer(edit.dataset.id);
      if (record) openModal(kind, record);
      return;
    }
    const remove = event.target.closest('[data-settings-delete]');
    if (!remove) return;
    const kind = remove.dataset.settingsDelete;
    editor = { kind, id: remove.dataset.id };
    try {
      await removeCurrent();
      editor = null;
      toast('Registro excluído');
      await reload(root);
    } catch (error) {
      editor = null;
      toast(error.message || 'Não foi possível excluir', { tone: 'error' });
    }
  });
}

export async function renderAgroSettings(root) {
  const actions = root.querySelector('.forms-top-actions');
  if (actions) {
    actions.innerHTML = `
      <button class="btn-ghost" type="button" data-settings-new="property">Nova propriedade</button>
      <button class="btn" type="button" data-settings-new="producer">Novo produtor</button>`;
  }
  bind(root);
  bindModal(root);
  const body = root.querySelector('#agro-body');
  if (body) body.innerHTML = `<p class="muted">Carregando…</p>`;
  try {
    settings = await api('/api/agro/settings');
  } catch (error) {
    if (body) {
      body.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Não foi possível carregar as configurações')}</p>`;
    }
    return;
  }
  paint(root);
}
