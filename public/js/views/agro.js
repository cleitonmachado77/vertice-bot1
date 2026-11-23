import { api } from '../api.js';
import { getNavToken, isNavActive } from '../nav.js';
import { escapeHtml, toast } from '../ui.js';
import {
  costFormHtml,
  deliveryFormHtml,
  harvestFormHtml,
  plantingFormHtml,
  readAgroForm,
  syncDeliveryForm,
  syncDeliveryTotal,
  syncPlantingForm,
  syncQtyPriceTotal,
} from './agro-editor.js';
import { AGRO_TABS, bodyHtml, shell, tabMeta } from './agro-list.js';
import { openAgroPresets } from './agro-presets.js';
import { renderAgroDashboard, stopAgroDashboard } from './agro-dashboard.js';
import { renderAgroSettings } from './agro-settings.js';

export { AGRO_TABS, stopAgroDashboard };

const COLLECTIONS = {
  plantio: 'plantings',
  colheita: 'harvests',
  entrega: 'deliveries',
  custos: 'costs',
};
const OPERATIONAL = new Set(['plantio', 'colheita', 'entrega', 'custos']);

let snapshot = null;
let currentTab = 'dashboard';
let editor = null;

export function agroTabFromSlug(slug) {
  return AGRO_TABS.find((tab) => tab.slug === slug || tab.id === slug)?.id || 'dashboard';
}

export function closeAgroModal() {
  const modal = document.getElementById('agro-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('is-open');
  document.body.classList.remove('agro-modal-open');
  editor = null;
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
  modal = document.getElementById('agro-modal');
  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) closeAgroModal();
    if (event.target.closest('[data-delete-modal]')) {
      if (!editor?.kind || !COLLECTIONS[editor.kind]) return;
      event.preventDefault();
      removeRecord(editor.kind, editor.id);
    }
  });
  modal.addEventListener('change', (event) => {
    const form = event.target.closest('#agro-form');
    if (!form || !snapshot) return;
    if (form.dataset.kind === 'plantio') syncPlantingForm(form, snapshot.catalog);
    if (form.dataset.kind === 'entrega') syncDeliveryForm(form, snapshot.catalog, snapshot.plantings);
  });
  modal.addEventListener('input', (event) => {
    const form = event.target.closest('#agro-form');
    if (event.target?.name === 'unitPrice') event.target.dataset.touched = '1';
    if (form?.dataset.kind === 'entrega' || form?.dataset.kind === 'custos') syncQtyPriceTotal(form);
  });
  modal.addEventListener('submit', onSubmit);
  return modal;
}

function openEditor(kind, record) {
  if (!snapshot) return;
  const modal = ensureModal();
  const plantings = snapshot.plantings || [];
  const html =
    kind === 'colheita'
      ? harvestFormHtml(record, snapshot.catalog, plantings)
      : kind === 'entrega'
        ? deliveryFormHtml(record, snapshot.catalog, plantings)
        : kind === 'custos'
          ? costFormHtml(record, snapshot.catalog)
          : plantingFormHtml(record, snapshot.catalog);
  modal.querySelector('#agro-editor').innerHTML = html;
  editor = { kind, id: record?.id || '', collection: COLLECTIONS[kind] };
  const form = modal.querySelector('#agro-form');
  if (form?.dataset.kind === 'plantio') syncPlantingForm(form, snapshot.catalog);
  if (form?.dataset.kind === 'entrega') syncDeliveryForm(form, snapshot.catalog, snapshot.plantings);
  if (form?.dataset.kind === 'custos') syncQtyPriceTotal(form);
  modal.hidden = false;
  modal.classList.add('is-open');
  document.body.classList.add('agro-modal-open');
}

function recordById(kind, id) {
  const list =
    kind === 'colheita'
      ? snapshot?.harvests
      : kind === 'entrega'
        ? snapshot?.deliveries
        : kind === 'custos'
          ? snapshot?.costs
          : snapshot?.plantings;
  return (list || []).find((item) => item.id === id);
}

async function removeRecord(kind, id) {
  if (!kind || !id) return;
  const label = tabMeta(kind).label.toLowerCase();
  if (!confirm(`Excluir este registro de ${label}?`)) return;
  try {
    await api(`/api/agro/${COLLECTIONS[kind]}/${id}`, { method: 'DELETE' });
    closeAgroModal();
    toast('Registro excluído');
    await refresh();
  } catch (error) {
    toast(error.message || 'Não foi possível excluir', { tone: 'error' });
  }
}

async function onSubmit(event) {
  const form = event.target;
  if (form?.id !== 'agro-form' || !editor) return;
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  const path = editor.id ? `/api/agro/${editor.collection}/${editor.id}` : `/api/agro/${editor.collection}`;
  try {
    await api(path, { method: 'POST', body: readAgroForm(form) });
    closeAgroModal();
    toast('Registro salvo');
    await refresh();
  } catch (error) {
    toast(error.message || 'Não foi possível salvar', { tone: 'error' });
    button.disabled = false;
  }
}

async function refresh() {
  const root = document.querySelector('#agro-view');
  if (!root) return;
  snapshot = null;
  await renderAgro(root, currentTab, getNavToken(), { force: true });
}

function bind(root) {
  if (root.dataset.agroBound === '1') return;
  root.dataset.agroBound = '1';
  root.addEventListener('input', (event) => {
    if (event.target.matches('[data-filter]')) {
      const query = event.target.value.trim().toLowerCase();
      root.querySelectorAll('[data-search]').forEach((row) => {
        row.hidden = Boolean(query) && !row.dataset.search.includes(query);
      });
      return;
    }
  });
  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-group-delivery]')) syncGroupSaleButton(root);
  });
  root.addEventListener('click', (event) => {
    const presets = event.target.closest('[data-presets]');
    if (presets) {
      openAgroPresets(currentTab).catch((error) =>
        toast(error.message || 'Não foi possível abrir os padrões', { tone: 'error' }),
      );
      return;
    }
    const create = event.target.closest('[data-new]');
    if (create) {
      openEditor(create.dataset.new, null);
      return;
    }
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      openEditor(edit.dataset.edit, recordById(edit.dataset.edit, edit.dataset.id));
      return;
    }
    const go = event.target.closest('[data-go]');
    if (go) {
      sessionStorage.setItem('agro-pending', JSON.stringify({ tab: go.dataset.go, plantingId: go.dataset.planting }));
      location.hash = `#/agro/${go.dataset.go}`;
      return;
    }
    const closePlanting = event.target.closest('[data-close-planting]');
    if (closePlanting) {
      closePlantingRecord(closePlanting.dataset.closePlanting);
      return;
    }
    const groupSale = event.target.closest('[data-group-sale]');
    if (groupSale) {
      groupSelectedDeliveries(root);
      return;
    }
    const remove = event.target.closest('[data-delete]');
    if (remove) removeRecord(remove.dataset.delete, remove.dataset.id);
  });
}

function selectedGroupDeliveries(root) {
  return [...root.querySelectorAll('[data-group-delivery]:checked')].map((input) => ({
    id: input.value,
    partnerId: input.dataset.partner || '',
  }));
}

function syncGroupSaleButton(root) {
  const button = root.querySelector('[data-group-sale]');
  const hint = root.querySelector('[data-group-hint]');
  if (!button) return;
  const selected = selectedGroupDeliveries(root);
  const partners = [...new Set(selected.map((item) => item.partnerId).filter(Boolean))];
  const ok = selected.length > 0 && partners.length === 1;
  button.disabled = !ok;
  if (hint) {
    if (!selected.length) {
      hint.textContent = 'Selecione entregas do mesmo local (ainda sem pedido).';
    } else if (partners.length > 1) {
      hint.textContent = 'Selecione apenas um local de entrega por vez.';
    } else {
      hint.textContent = `${selected.length} entrega(s) pronta(s) para gerar um pedido no Odoo.`;
    }
  }
}

async function groupSelectedDeliveries(root) {
  const selected = selectedGroupDeliveries(root);
  const partners = [...new Set(selected.map((item) => item.partnerId).filter(Boolean))];
  if (!selected.length || partners.length !== 1) {
    toast('Selecione entregas do mesmo local', { tone: 'error' });
    return;
  }
  if (!confirm(`Gerar um pedido no Odoo com ${selected.length} entrega(s)?`)) return;
  const button = root.querySelector('[data-group-sale]');
  if (button) button.disabled = true;
  try {
    const result = await api('/api/agro/deliveries/group-sale', {
      method: 'POST',
      body: { deliveryIds: selected.map((item) => item.id) },
    });
    toast(result.orderName ? `Pedido ${result.orderName} gerado` : 'Pedido gerado no Odoo');
    await refresh();
  } catch (error) {
    toast(error.message || 'Não foi possível gerar o pedido', { tone: 'error' });
    syncGroupSaleButton(root);
  }
}

async function closePlantingRecord(id) {
  if (!id) return;
  if (!confirm('Encerrar a colheita deste plantio?')) return;
  try {
    await api(`/api/agro/plantings/${encodeURIComponent(id)}/close`, { method: 'POST', body: {} });
    toast('Plantio encerrado');
    await refresh();
  } catch (error) {
    toast(error.message || 'Não foi possível encerrar o plantio', { tone: 'error' });
  }
}

function takePending(tab) {
  const raw = sessionStorage.getItem('agro-pending');
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value.tab !== tab) return null;
    sessionStorage.removeItem('agro-pending');
    return value;
  } catch {
    sessionStorage.removeItem('agro-pending');
    return null;
  }
}

function updateToolbar(root) {
  const meta = tabMeta(currentTab);
  const title = root.querySelector('.page-head h1');
  const lead = root.querySelector('.page-head .muted');
  const actions = root.querySelector('.forms-top-actions');
  if (title) title.textContent = meta.label;
  if (lead) {
    lead.textContent =
      currentTab === 'dashboard'
        ? `${meta.description}.`
        : `${meta.description}. Os registros seguem a empresa ativa do Odoo.`;
  }
  if (!actions) return;
  if (currentTab === 'configuracoes') {
    actions.innerHTML = `
      <button class="btn-ghost" type="button" data-settings-new="property">Nova propriedade</button>
      <button class="btn" type="button" data-settings-new="producer">Novo produtor</button>`;
    return;
  }
  if (currentTab === 'dashboard') {
    actions.innerHTML = '';
    actions.id = 'agro-dash-actions';
    return;
  }
  actions.removeAttribute('id');
  const presets =
    currentTab === 'custos' ? '' : `<button class="btn-ghost" type="button" data-presets>Padrões</button>`;
  actions.innerHTML = `
    ${presets}
    <button class="btn" type="button" data-new="${escapeHtml(currentTab)}">Novo</button>`;
}

export async function renderAgro(root, tab = 'dashboard', token = getNavToken(), options = {}) {
  currentTab = AGRO_TABS.some((item) => item.id === tab) ? tab : 'dashboard';
  if (!options.keepModal) closeAgroModal();
  if (currentTab !== 'dashboard') stopAgroDashboard();

  if (!root.querySelector('.agro-pane')) root.innerHTML = shell(currentTab);
  else updateToolbar(root);

  if (currentTab === 'configuracoes') {
    await renderAgroSettings(root);
    return;
  }

  if (currentTab === 'dashboard') {
    await renderAgroDashboard(root);
    return;
  }

  bind(root);
  const body = root.querySelector('#agro-body');
  const reuse = Boolean(options.soft && snapshot && !options.force && OPERATIONAL.has(currentTab));
  if (!reuse) {
    if (body) body.innerHTML = `<p class="muted">Carregando…</p>`;
    try {
      snapshot = await api('/api/agro');
    } catch (error) {
      if (!isNavActive(token)) return;
      if (body) {
        body.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Não foi possível carregar o Vertice Agro')}</p>`;
      }
      return;
    }
  }
  if (!isNavActive(token)) return;
  if (body) body.innerHTML = bodyHtml(currentTab, snapshot);
  if (currentTab === 'entrega') syncGroupSaleButton(root);
  const pending = takePending(currentTab);
  if (!pending) return;
  if (pending.tab === 'colheita') openEditor('colheita', { plantingId: pending.plantingId });
  if (pending.tab === 'entrega') openEditor('entrega', { plantingId: pending.plantingId });
}
