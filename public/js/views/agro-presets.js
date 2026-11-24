import { api } from '../api.js';
import { escapeHtml, toast } from '../ui.js';

function ensureModal() {
  let modal = document.getElementById('agro-modal');
  if (modal) return modal;
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="forms-modal" id="agro-modal" hidden>
      <div class="forms-modal-backdrop" data-close-modal tabindex="-1"></div>
      <section class="card forms-editor-card forms-modal-dialog" id="agro-editor" role="dialog" aria-modal="true"></section>
    </div>`,
  );
  modal = document.getElementById('agro-modal');
  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) closeModal();
  });
  return modal;
}

function closeModal() {
  const modal = document.getElementById('agro-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('is-open');
  document.body.classList.remove('agro-modal-open');
}

function openModal() {
  const modal = ensureModal();
  modal.hidden = false;
  modal.classList.add('is-open');
  document.body.classList.add('agro-modal-open');
}

async function load(kind) {
  return api(`/api/agro/presets?kind=${encodeURIComponent(kind)}`);
}

export async function openAgroPresets(tab) {
  const pack = await load(tab);
  paintList(tab, pack);
}

function paintList(tab, pack) {
  const editor = ensureModal().querySelector('#agro-editor');
  const items = pack.items || [];
  editor.innerHTML = `
    <header class="forms-editor-head">
      <div>
        <h2>Padrões</h2>
        <p class="muted">Campos “Mostrar” definem o registro e, se o Bot estiver ativo, as perguntas no WhatsApp.</p>
      </div>
    </header>
    <div class="row">
      <button class="btn" type="button" data-preset-create>Novo padrão</button>
      <button class="btn-ghost" type="button" data-close-modal>Fechar</button>
    </div>
    <div class="forms-presets-list">
      ${
        items.length
          ? items
              .map(
                (preset) => `<div class="forms-presets-row">
            <div><strong>${escapeHtml(preset.name)}</strong>
              <span class="muted">${preset.bot_enabled ? 'Bot ativo' : 'Só no painel'}</span></div>
            <div class="row">
              ${preset.bot_enabled ? `<button class="btn" type="button" data-preset-send="${escapeHtml(preset.id)}">Enviar agora</button>` : ''}
              <button class="btn-ghost" type="button" data-preset-edit="${escapeHtml(preset.id)}">Editar</button>
              <button class="btn-danger" type="button" data-preset-delete="${escapeHtml(preset.id)}">Excluir</button>
            </div>
          </div>`,
              )
              .join('')
          : '<p class="muted">Nenhum padrão nesta empresa. Crie um para o Vertice Bot perguntar pelo WhatsApp.</p>'
      }
    </div>`;
  openModal();
  editor.querySelector('[data-preset-create]')?.addEventListener('click', () => paintEditor(tab, pack, null));
  editor.querySelectorAll('[data-preset-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = items.find((item) => item.id === button.getAttribute('data-preset-edit'));
      if (preset) paintEditor(tab, pack, preset);
    });
  });
  editor.querySelectorAll('[data-preset-send]').forEach((button) => {
    button.addEventListener('click', () => sendNow(button));
  });
  editor.querySelectorAll('[data-preset-delete]').forEach((button) => {
    button.addEventListener('click', () => removePreset(tab, button.getAttribute('data-preset-delete')));
  });
}

function paintEditor(tab, pack, preset) {
  const editor = document.querySelector('#agro-editor');
  const visible = new Set(preset?.visible || (pack.fields || []).map((field) => field.key));
  const header = preset?.header || {};
  editor.innerHTML = `
    <header class="forms-editor-head">
      <div>
        <h2>${preset ? 'Editar padrão' : 'Novo padrão'}</h2>
        <p class="muted">Marque Mostrar para o campo entrar no registro. Valor preenchido não vira pergunta no WhatsApp.</p>
      </div>
    </header>
    <form id="agro-preset-form" class="agro-form">
      <label>Nome do padrão
        <input name="name" required maxlength="60" value="${escapeHtml(preset?.name || '')}" placeholder="ex.: Plantio da semana">
      </label>
      <div class="forms-bot-panel">
        <label class="forms-preset-show forms-preset-bot">
          <input type="checkbox" name="bot_enabled" value="1" ${preset?.bot_enabled ? 'checked' : ''}>
          <span>Enviar pelo Vertice Bot (WhatsApp)</span>
        </label>
        <div class="forms-bot-schedule" data-bot-schedule ${preset?.bot_enabled ? '' : 'hidden'}>
          <label>Contato destinatário
            <select name="bot_contact_id"><option value="">Carregando contatos…</option></select>
          </label>
          <label>Template Meta (janela 24h)
            <select name="bot_template_id"><option value="">Automático (template padrão)</option></select>
          </label>
          <p class="muted">Fica no menu do WhatsApp deste contato. Em dias úteis o menu sai no horário abaixo (ou no horário próprio do contato).</p>
          <label>Frequência
            <select name="bot_frequency">
              <option value="weekdays" ${(preset?.bot_frequency || 'weekdays') === 'weekdays' ? 'selected' : ''}>Dias úteis</option>
              <option value="daily" ${preset?.bot_frequency === 'daily' ? 'selected' : ''}>Todos os dias</option>
            </select>
          </label>
          <label>Horário
            <input name="bot_send_time" type="time" value="${escapeHtml(preset?.bot_send_time || '13:30')}" required>
          </label>
          <label class="forms-preset-show">
            <input type="checkbox" name="confirm_before_close" value="1" ${preset?.bot_rules?.confirm_before_close ? 'checked' : ''}>
            <span>Pedir confirmação antes de registrar</span>
          </label>
          ${preset ? '<button class="btn" type="button" data-preset-send-form>Enviar agora</button>' : ''}
        </div>
      </div>
      <section class="forms-section">
        <h2>Campos</h2>
        <div class="agro-preset-fields">
          <div class="agro-preset-head" aria-hidden="true">
            <span>Mostrar</span>
            <span>Campo</span>
            <span>Valor padrão</span>
          </div>
          ${(pack.fields || [])
            .map(
              (field) => `<div class="agro-preset-field">
            <label class="forms-preset-show">
              <input type="checkbox" name="show_${escapeHtml(field.key)}" value="1" ${visible.has(field.key) ? 'checked' : ''} aria-label="Mostrar ${escapeHtml(field.label)}">
            </label>
            <span class="agro-preset-name">${escapeHtml(field.label)}<span class="agro-sub">${field.odoo ? 'Odoo' : 'Vertice'}</span></span>
            ${defaultControl(field, header, pack.catalog || {})}
          </div>`,
            )
            .join('')}
        </div>
      </section>
      <div class="agro-form-actions">
        <button class="btn" type="submit">Salvar padrão</button>
        <button class="btn-ghost" type="button" data-preset-back>Voltar</button>
      </div>
    </form>`;
  const form = editor.querySelector('#agro-preset-form');
  form.querySelector('[name=bot_enabled]')?.addEventListener('change', (event) => {
    form.querySelector('[data-bot-schedule]').hidden = !event.target.checked;
  });
  form.querySelector('[data-preset-back]')?.addEventListener('click', () => paintList(tab, pack));
  form.querySelector('[data-preset-send-form]')?.addEventListener('click', (event) => sendNow(event.currentTarget, preset.id));
  const productDefault = form.querySelector('[data-product-default]');
  productDefault?.addEventListener('change', (event) => {
    const unit = form.querySelector('[name=default_unit]');
    const chosen = event.target.selectedOptions?.[0];
    if (!unit || !chosen) return;
    const uom = chosen.dataset.uom || '';
    if (uom) {
      unit.value = uom;
      unit.readOnly = true;
    } else if (!event.target.value) {
      unit.readOnly = false;
    }
  });
  if (productDefault?.value) productDefault.dispatchEvent(new Event('change'));
  form.addEventListener('submit', (event) => savePreset(event, tab, pack, preset));
  fillContacts(form, preset?.bot_contact_id || '');
  fillTemplates(form, preset?.bot_template_id || '');
}

function catalogOptions(items, selected, withUom) {
  const names = (items || []).map((item) => ({
    value: item.name,
    label: withUom && item.uom ? `${item.name} · ${item.uom}` : item.name,
    uom: item.uom || '',
  }));
  if (selected && !names.some((item) => item.value === selected)) {
    names.unshift({ value: selected, label: selected, uom: '' });
  }
  return names
    .map(
      (item) =>
        `<option value="${escapeHtml(item.value)}" ${item.value === selected ? 'selected' : ''} ${item.uom ? `data-uom="${escapeHtml(item.uom)}"` : ''}>${escapeHtml(item.label)}</option>`,
    )
    .join('');
}

function defaultControl(field, header, catalog) {
  const value = header[field.key] || '';
  const name = `default_${field.key}`;
  if (field.catalog === 'producer') {
    return `<select name="${name}" aria-label="Fornecedor padrão"><option value="">O Bot pergunta</option>${catalogOptions(catalog.producers, value, false)}</select>`;
  }
  if (field.catalog === 'product') {
    return `<select name="${name}" data-product-default aria-label="Produto padrão"><option value="">O Bot pergunta</option>${catalogOptions(catalog.products, value, true)}</select>`;
  }
  if (field.catalog === 'buyer') {
    return `<select name="${name}" aria-label="Comprador padrão"><option value="">O Bot pergunta</option>${catalogOptions(catalog.buyers, value, false)}</select>`;
  }
  const unitLocked = field.key === 'unit' && header.productName;
  return `<input name="${name}" value="${escapeHtml(value)}" placeholder="${field.odoo ? 'Igual ao Odoo' : 'Opcional'}" aria-label="Valor padrão de ${escapeHtml(field.label)}" ${unitLocked ? 'readonly' : ''}>`;
}

async function fillContacts(form, selected) {
  const select = form.querySelector('[name=bot_contact_id]');
  try {
    const data = await api('/api/contacts');
    const items = Array.isArray(data.items) ? data.items : [];
    select.innerHTML = `<option value="">Selecione</option>${items
      .map(
        (item) =>
          `<option value="${escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.name || item.phone || item.id)}</option>`,
      )
      .join('')}`;
  } catch {
    select.innerHTML = '<option value="">Não foi possível carregar contatos</option>';
  }
}

async function fillTemplates(form, selected) {
  const select = form.querySelector('[name=bot_template_id]');
  try {
    const data = await api('/api/questionnaires/templates');
    const items = Array.isArray(data.items) ? data.items : [];
    select.innerHTML = `<option value="">Automático (template padrão)</option>${items
      .map(
        (item) =>
          `<option value="${escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.name || item.id)}</option>`,
      )
      .join('')}`;
  } catch {
    /* o automático continua disponível */
  }
}

async function savePreset(event, tab, pack, preset) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const header = {};
  const visible = [];
  for (const field of pack.fields || []) {
    if (data.get(`show_${field.key}`) === '1') visible.push(field.key);
    const value = String(data.get(`default_${field.key}`) || '').trim();
    if (value) header[field.key] = value;
  }
  const body = {
    kind: pack.kind,
    name: String(data.get('name') || ''),
    header,
    visible,
    bot_enabled: data.get('bot_enabled') === '1',
    bot_contact_id: String(data.get('bot_contact_id') || ''),
    bot_template_id: String(data.get('bot_template_id') || ''),
    bot_frequency: String(data.get('bot_frequency') || 'weekdays'),
    bot_send_time: String(data.get('bot_send_time') || '13:30'),
    bot_rules: { confirm_before_close: data.get('confirm_before_close') === '1' },
  };
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    if (preset?.id) await api(`/api/agro/presets/${encodeURIComponent(preset.id)}`, { method: 'PUT', body });
    else await api('/api/agro/presets', { method: 'POST', body });
    toast('Padrão salvo');
    paintList(tab, await load(tab));
  } catch (error) {
    toast(error.message || 'Não foi possível salvar o padrão', { tone: 'error' });
    button.disabled = false;
  }
}

async function sendNow(button, id = button.getAttribute('data-preset-send')) {
  if (!id) return;
  button.disabled = true;
  try {
    const result = await api(`/api/agro/presets/${encodeURIComponent(id)}/bot-send`, { method: 'POST', body: {} });
    toast(`Perguntas enviadas para ${result.phone || 'WhatsApp'}`);
  } catch (error) {
    toast(error.message || 'Falha ao enviar pelo Bot', { tone: 'error' });
  } finally {
    button.disabled = false;
  }
}

async function removePreset(tab, id) {
  if (!id || !confirm('Excluir este padrão?')) return;
  try {
    await api(`/api/agro/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Padrão excluído');
    paintList(tab, await load(tab));
  } catch (error) {
    toast(error.message || 'Falha ao excluir', { tone: 'error' });
  }
}
