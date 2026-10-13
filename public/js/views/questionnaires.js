import { api } from '../api.js';
import { escapeHtml, toast } from '../ui.js';

const FREQUENCIES = [
  ['daily', 'Todos os dias'],
  ['weekdays', 'Dias úteis'],
  ['weekly', 'Um dia da semana'],
];
const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const TYPES = [
  ['any', 'Qualquer (texto, áudio, imagem ou vídeo)'],
  ['text', 'Texto ou áudio'],
  ['audio', 'Áudio'],
  ['image', 'Imagem'],
  ['video', 'Vídeo'],
];

let editingId = '';
let tab = 'modelos';

export async function renderQuestionnaires(root) {
  root.innerHTML = `
    <div class="top">
      <div>
        <p class="kicker">Acompanhamento</p>
        <h1>Questionários</h1>
      </div>
    </div>
    <nav class="settings-tabs" aria-label="Seções de questionários">
      <a class="settings-tab${tab === 'modelos' ? ' active' : ''}" href="#/questionnaires" data-tab="modelos">Modelos</a>
      <a class="settings-tab${tab === 'dados' ? ' active' : ''}" href="#/questionnaires" data-tab="dados">Dados</a>
    </nav>
    <div id="questionnaires-panel"></div>`;

  root.querySelectorAll('[data-tab]').forEach((link) => {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      tab = link.dataset.tab;
      await renderQuestionnaires(root);
    });
  });

  const panel = root.querySelector('#questionnaires-panel');
  if (tab === 'dados') await renderData(panel);
  else await renderModels(panel);
}

async function renderModels(root) {
  const [data, contacts, templates] = await Promise.all([
    api('/api/questionnaires'),
    api('/api/contacts'),
    api('/api/questionnaires/templates').catch(() => ({ items: [], selectedId: '' })),
  ]);
  const editing = editingId ? data.items.find((item) => item.id === editingId) : null;
  if (editingId && !editing) editingId = '';
  const contactItems = contacts.items || [];

  const item = editing || {};
  root.innerHTML = `
    <div class="q-board">
      <form class="card stack" id="template-form">
        <div class="card-head">
          <h2>1. Template de primeiro envio</h2>
          <p class="muted">No horário agendado o sistema envia este template Meta, não o texto do questionário.</p>
        </div>
        <label>Template</label>
        <select name="templateId">
          <option value="">Usar o primeiro template aprovado</option>
          ${(templates.items || [])
            .map(
              (row) =>
                `<option value="${escapeHtml(row.id)}" ${
                  row.id === (data.templateId || templates.selectedId) ? 'selected' : ''
                }>${escapeHtml(row.name)}</option>`,
            )
            .join('')}
        </select>
        <button class="btn" type="submit">Salvar template</button>
      </form>

      <section class="card stack" id="questionnaire-list">
        <div class="card-head">
          <h2>2. Questionários cadastrados</h2>
          <p class="muted">Selecione um modelo para editar ou exclua o que não usar mais.</p>
        </div>
        <div class="stack q-list-scroll">
          ${data.items.map((row) => listCard(row, contactItems)).join('') || '<p class="muted">Nenhum questionário ainda.</p>'}
        </div>
      </section>

      <form id="questionnaire-form" class="q-form-grid">
        <section class="card stack">
          <div class="card-head">
            <h2>3. ${editing ? 'Editar modelo' : 'Novo modelo'}</h2>
            <p class="muted">${editing ? 'Nome, saudação e agenda de envio.' : 'Defina o nome e quando o envio deve acontecer.'}</p>
          </div>
          ${modelFields(item)}
          <div class="row form-actions">
            <button class="btn" type="submit">${editing ? 'Salvar' : 'Criar questionário'}</button>
            ${editing ? '<button class="btn-ghost" id="cancel-edit" type="button">Cancelar</button>' : ''}
          </div>
        </section>

        <section class="card stack">
          <div class="card-head">
            <h2>4. Contatos e perguntas</h2>
            <p class="muted">O agente entende respostas em texto, áudio, imagem ou vídeo.</p>
          </div>
          ${assignFields(item, contactItems)}
        </section>
      </form>
    </div>`;

  document.querySelector('#template-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/questionnaires/settings', {
        method: 'PUT',
        body: { templateId: form.get('templateId') || '' },
      });
      toast('Template de primeiro envio salvo');
    } catch (error) {
      toast(error.message);
    }
  });

  bindForm(document.querySelector('#questionnaire-form'), editing?.id || '', contactItems);
  document.querySelector('#cancel-edit')?.addEventListener('click', async () => {
    editingId = '';
    await renderQuestionnaires(document.querySelector('#view'));
  });
  root.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', async () => {
      editingId = button.dataset.edit;
      await renderQuestionnaires(document.querySelector('#view'));
    });
  });
  root.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Excluir este questionário?')) return;
      try {
        await api(`/api/questionnaires/${encodeURIComponent(button.dataset.remove)}`, {
          method: 'DELETE',
          body: {},
        });
        if (editingId === button.dataset.remove) editingId = '';
        toast('Questionário removido');
        await renderQuestionnaires(document.querySelector('#view'));
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

async function renderData(root) {
  const [questionnaires, data] = await Promise.all([
    api('/api/questionnaires'),
    api('/api/questionnaires/data'),
  ]);
  const filterId = root.dataset.filterId || '';
  const all = data.items || [];
  const items = all.filter((item) => !filterId || item.questionnaire_id === filterId);
  const answered = items.filter((item) => item.answer_text).length;
  const cycles = new Set(items.map((item) => item.cycle_id).filter(Boolean));
  const completed = new Set(
    items.filter((item) => item.cycle_status === 'completed').map((item) => item.cycle_id),
  ).size;
  const options = (questionnaires.items || [])
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}" ${item.id === filterId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`,
    )
    .join('');

  root.innerHTML = `
    <div class="data-layout">
      <section class="card data-toolbar">
        <div class="card-head">
          <h2>Dados coletados</h2>
          <p class="muted">Respostas identificadas pelo agente nas conversas de questionário.</p>
        </div>
        <div class="data-toolbar-row">
          <div class="data-filter-field">
            <label>Questionário</label>
            <select id="data-filter">
              <option value="">Todos</option>
              ${options}
            </select>
          </div>
          <div class="data-stats">
            <div class="data-stat">
              <span class="muted">Respostas</span>
              <strong>${answered}</strong>
            </div>
            <div class="data-stat">
              <span class="muted">Ciclos</span>
              <strong>${cycles.size}</strong>
            </div>
            <div class="data-stat">
              <span class="muted">Concluídos</span>
              <strong>${completed}</strong>
            </div>
          </div>
        </div>
      </section>

      <section class="card stack data-results">
        ${
          items.length
            ? `<div class="data-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Contato</th>
                      <th>Questionário</th>
                      <th>Pergunta</th>
                      <th>Resposta</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>${items.map(dataRow).join('')}</tbody>
                </table>
              </div>`
            : `<div class="data-empty">
                <strong>Nenhuma resposta ainda</strong>
                <p class="muted">Quando o agente coletar respostas nos ciclos abertos, elas aparecem aqui.</p>
              </div>`
        }
      </section>
    </div>`;

  root.querySelector('#data-filter')?.addEventListener('change', async (event) => {
    root.dataset.filterId = event.target.value;
    await renderData(root);
  });
}

function dataRow(item) {
  const status =
    item.cycle_status === 'completed'
      ? 'Concluído'
      : item.cycle_status === 'notified'
        ? 'Aguardando'
        : item.cycle_status === 'open'
          ? 'Aberto'
          : escapeHtml(item.cycle_status || '-');
  return `
    <tr>
      <td class="data-date">${escapeHtml(item.occurrence_date || '')}</td>
      <td>
        <strong>${escapeHtml(item.contact_name || 'Sem nome')}</strong>
        <div class="muted">${escapeHtml(item.contact_phone || '')}</div>
      </td>
      <td>${escapeHtml(item.questionnaire_name || '')}</td>
      <td>${escapeHtml(item.question_body || '')}</td>
      <td class="data-answer">
        ${escapeHtml(item.answer_text || '—')}
        ${
          item.media_url
            ? `<div class="muted"><a href="${escapeHtml(item.media_url)}" target="_blank" rel="noopener">Ver mídia (${escapeHtml(item.answer_type || 'arquivo')})</a></div>`
            : item.answer_type && item.answer_type !== 'text'
              ? `<div class="muted">${escapeHtml(item.answer_type)}</div>`
              : ''
        }
      </td>
      <td><span class="pill ${item.cycle_status === 'completed' ? '' : 'off'}">${status}</span></td>
    </tr>`;
}

function modelFields(item = {}) {
  const frequency = item.frequency || 'daily';
  const freqOptions = FREQUENCIES.map(
    ([value, label]) => `<option value="${value}" ${value === frequency ? 'selected' : ''}>${label}</option>`,
  ).join('');
  const days = DAYS.map(
    (label, index) => `<option value="${index}" ${Number(item.weekday ?? 1) === index ? 'selected' : ''}>${label}</option>`,
  ).join('');
  return `
    <div>
      <label>Nome</label>
      <input name="name" required value="${escapeHtml(item.name || '')}" placeholder="Acompanhamento diário" />
    </div>
    <div>
      <label>Saudação (referência interna)</label>
      <textarea class="short" name="greeting" placeholder="Olá {{1}}, bom dia! Aqui é a Vértice.">${escapeHtml(item.greeting || '')}</textarea>
    </div>
    <div class="field-block">
      <div class="field-block-head">
        <span class="field-title">Agenda</span>
      </div>
      <div class="grid-2 schedule-grid">
        <div>
          <label>Frequência</label>
          <select name="frequency">${freqOptions}</select>
        </div>
        <div class="weekday-field" ${frequency === 'weekly' ? '' : 'hidden'}>
          <label>Dia</label>
          <select name="weekday">${days}</select>
        </div>
        <div>
          <label>Horário (Brasília)</label>
          <input name="sendTime" value="${escapeHtml(item.send_time || '09:00')}" placeholder="09:00" />
        </div>
      </div>
      <label class="check"><input name="active" type="checkbox" ${item.active === 0 ? '' : 'checked'}/> Questionário ativo</label>
    </div>`;
}

function assignFields(item = {}, contacts = []) {
  const questions = (item.questions || []).map(questionCard).join('') || questionCard();
  const selected = new Set(item.contactIds || []);
  const contactChecks = contacts.length
    ? contacts
        .map(
          (contact) => `
        <label class="check contact-check">
          <input type="checkbox" name="contactIds" value="${escapeHtml(contact.id)}" ${
            selected.has(contact.id) ? 'checked' : ''
          }/>
          <span>
            <strong>${escapeHtml(contact.name || 'Sem nome')}</strong>
            <span class="muted">${escapeHtml(contact.phone || '')}</span>
          </span>
        </label>`,
        )
        .join('')
    : '<p class="muted">Nenhum contato cadastrado ainda.</p>';

  return `
    <div class="field-block" style="border-top: 0; padding-top: 0;">
      <div class="field-block-head">
        <span class="field-title">Contatos atribuídos</span>
      </div>
      <div class="contact-assign-list">${contactChecks}</div>
    </div>
    <div class="field-block">
      <div class="field-block-head">
        <span class="field-title">Perguntas</span>
        <button class="btn-ghost add-question" type="button">Adicionar</button>
      </div>
      <div class="stack questions">${questions}</div>
    </div>
    ${
      item.preview
        ? `<div class="field-block">
            <div class="field-block-head"><span class="field-title">Prévia das perguntas</span></div>
            <pre class="preview-box">${escapeHtml(item.preview)}</pre>
          </div>`
        : ''
    }`;
}

function questionCard(item = {}) {
  const type = item.expected_type || 'any';
  const options = TYPES.map(
    ([value, label]) => `<option value="${value}" ${value === type ? 'selected' : ''}>${label}</option>`,
  ).join('');
  return `
    <article class="q-item" data-id="${escapeHtml(item.id || '')}">
      <textarea class="short" name="body" placeholder="Como foi seu dia?" required>${escapeHtml(item.body || '')}</textarea>
      <div class="q-item-meta">
        <select name="expectedType" aria-label="Tipo esperado">${options}</select>
        <button class="btn-danger remove-question" type="button">Remover</button>
      </div>
    </article>`;
}

function listCard(item, contacts = []) {
  const count = item.questions?.length || 0;
  const assigned = (item.contactIds || []).length;
  const names = (item.contactIds || [])
    .map((id) => contacts.find((contact) => contact.id === id)?.name || id)
    .slice(0, 3)
    .join(', ');
  const freq = FREQUENCIES.find(([value]) => value === item.frequency)?.[1] || item.frequency;
  const when =
    item.frequency === 'weekly'
      ? `${DAYS[Number(item.weekday) || 0]} · ${escapeHtml(item.send_time || '')}`
      : `${freq} · ${escapeHtml(item.send_time || '')}`;
  return `
    <article class="q-list-card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <p class="muted" style="margin: 6px 0 0;">${when} · ${count} pergunta${count === 1 ? '' : 's'} · ${assigned} contato${assigned === 1 ? '' : 's'}</p>
        </div>
        <span class="pill ${item.active ? '' : 'off'}">${item.active ? 'Ativo' : 'Pausado'}</span>
      </div>
      <p class="muted q-list-preview">${escapeHtml(names || 'Nenhum contato atribuído')}${
        assigned > 3 ? '…' : ''
      }</p>
      <div class="row">
        <button type="button" class="btn" data-edit="${escapeHtml(item.id)}">Editar</button>
        <button type="button" class="btn-danger" data-remove="${escapeHtml(item.id)}">Excluir</button>
      </div>
    </article>`;
}

function bindForm(form, id) {
  if (!form) return;
  const questions = form.querySelector('.questions');
  const frequency = form.querySelector('[name=frequency]');
  const weekday = form.querySelector('.weekday-field');
  frequency?.addEventListener('change', () => {
    if (weekday) weekday.hidden = frequency.value !== 'weekly';
  });
  form.querySelector('.add-question')?.addEventListener('click', () => {
    questions.insertAdjacentHTML('beforeend', questionCard());
    bindQuestion(questions.lastElementChild);
  });
  questions.querySelectorAll('.q-item').forEach(bindQuestion);
  form.addEventListener('submit', (event) => save(event, id));
}

function bindQuestion(card) {
  card.querySelector('.remove-question')?.addEventListener('click', () => {
    const list = card.parentElement;
    card.remove();
    if (list && !list.querySelector('.q-item')) {
      list.insertAdjacentHTML('beforeend', questionCard());
      bindQuestion(list.lastElementChild);
    }
  });
}

async function save(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const questions = [...form.querySelectorAll('.q-item')].map((card) => ({
    id: card.dataset.id || undefined,
    body: card.querySelector('[name=body]').value,
    expectedType: card.querySelector('[name=expectedType]').value,
  }));
  const contactIds = [...form.querySelectorAll('[name=contactIds]:checked')].map((input) => input.value);
  try {
    await api(id ? `/api/questionnaires/${encodeURIComponent(id)}` : '/api/questionnaires', {
      method: id ? 'PUT' : 'POST',
      body: {
        name: data.get('name'),
        greeting: data.get('greeting'),
        frequency: data.get('frequency'),
        weekday: Number(data.get('weekday') || 1),
        sendTime: data.get('sendTime'),
        active: data.get('active') === 'on',
        contactIds,
        questions,
      },
    });
    editingId = '';
    toast(id ? 'Questionário salvo' : 'Questionário criado');
    await renderQuestionnaires(document.querySelector('#view'));
  } catch (error) {
    toast(error.message);
  }
}
