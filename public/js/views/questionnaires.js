import { api } from '../api.js';
import { escapeHtml, toast, panelLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

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
let rfqFields = [];

export async function renderQuestionnaires(root, token = getNavToken()) {
  root.innerHTML = `
    <div class="view-pane">
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
      <div id="questionnaires-panel">${panelLoading()}</div>
    </div>`;

  root.querySelectorAll('[data-tab]').forEach((link) => {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      tab = link.dataset.tab;
      await renderQuestionnaires(root, token);
    });
  });

  if (!isNavActive(token)) return;
  const panel = root.querySelector('#questionnaires-panel');
  if (tab === 'dados') await renderData(panel, token);
  else await renderModels(panel, token);
}

async function renderModels(root, token = getNavToken()) {
  if (!root.querySelector('#questionnaire-form')) root.innerHTML = panelLoading('Carregando modelos…');
  const [data, contacts, templates] = await Promise.all([
    api('/api/questionnaires'),
    api('/api/contacts'),
    api('/api/questionnaires/templates').catch(() => ({ items: [], selectedId: '' })),
  ]);
  if (!isNavActive(token)) return;
  rfqFields = data.rfqFields || rfqFields;
  const editing = editingId ? data.items.find((item) => item.id === editingId) : null;
  if (editingId && !editing) editingId = '';
  const contactItems = contacts.items || [];

  const item = editing || {};
  const selectedTemplateId = item.template_id || data.templateId || templates.selectedId || '';
  root.innerHTML = `
    <div class="q-board">
      <form class="card stack" id="questionnaire-form" data-greeting="${escapeHtml(item.greeting || '')}">
        <div class="card-head">
          <h2>${editing ? 'Editar modelo' : 'Novo modelo'}</h2>
          <p class="muted">Template, agenda, contatos e perguntas.</p>
        </div>

        <div class="field-block" style="border-top: 0; padding-top: 0;">
          <div class="field-block-head">
            <span class="field-title">Template Meta</span>
          </div>
          <select name="templateId" id="template-select">
            <option value="">Automático</option>
            ${(templates.items || [])
              .map((row) => {
                const pending = row.status === 'PENDING_APPROVAL' ? ' (pendente)' : '';
                return `<option value="${escapeHtml(row.id)}" ${
                  row.id === selectedTemplateId ? 'selected' : ''
                }>${escapeHtml(row.name)}${pending}</option>`;
              })
              .join('')}
          </select>
        </div>

        ${modelFields(item)}
        ${assignFields(item, contactItems)}
        ${defaultValuesFields(item)}

        <div class="row form-actions">
          <button class="btn" type="submit">${editing ? 'Salvar' : 'Criar questionário'}</button>
          ${editing ? '<button class="btn-ghost" id="cancel-edit" type="button">Cancelar</button>' : ''}
        </div>
      </form>

      <section class="card stack" id="questionnaire-list">
        <div class="card-head">
          <h2>Cadastrados</h2>
          <p class="muted">Edite ou exclua um modelo.</p>
        </div>
        <div class="stack q-list-scroll">
          ${data.items.map((row) => listCard(row, contactItems)).join('') || '<p class="muted">Nenhum questionário ainda.</p>'}
        </div>
      </section>
    </div>`;

  bindForm(document.querySelector('#questionnaire-form'), editing?.id || '');
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

async function renderData(root, token = getNavToken()) {
  const keepFilter = root.dataset.filterId || '';
  if (!root.querySelector('#data-filter')) root.innerHTML = panelLoading('Carregando dados…');
  const [questionnaires, data, operations] = await Promise.all([
    api('/api/questionnaires'),
    api('/api/questionnaires/data'),
    api('/api/questionnaires/operations').catch(() => ({ queue: [], failures: [] })),
  ]);
  if (!isNavActive(token)) return;
  rfqFields = questionnaires.rfqFields || data.rfqFields || rfqFields;
  if (keepFilter) root.dataset.filterId = keepFilter;
  const filterId = root.dataset.filterId || '';
  const all = data.items || [];
  const items = all.filter((item) => !filterId || item.questionnaire_id === filterId);
  const answered = items.filter((item) => item.answer_text).length;
  const cycles = new Set(items.map((item) => item.cycle_id).filter(Boolean));
  const completed = new Set(
    items.filter((item) => item.cycle_status === 'completed').map((item) => item.cycle_id),
  ).size;
  const activeQuestionnaires = questionnaires.items || [];
  const activeIds = new Set(activeQuestionnaires.map((item) => item.id));
  const archivedQuestionnaires = Array.from(
    new Map(
      all
        .filter((item) => item.questionnaire_id && !activeIds.has(item.questionnaire_id))
        .map((item) => [
          item.questionnaire_id,
          { id: item.questionnaire_id, name: `${item.questionnaire_name || 'Questionário'} (arquivado)` },
        ]),
    ).values(),
  );
  const options = [...activeQuestionnaires, ...archivedQuestionnaires]
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
          <button class="btn" type="button" id="download-rfq" ${filterId ? '' : 'disabled'} title="${
            filterId ? 'Baixar planilha RFQ consolidada' : 'Selecione um questionário para exportar'
          }">Baixar planilha</button>
        </div>
      </section>

      ${operationsPanel(operations)}

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
    await renderData(root, token);
  });
  root.querySelector('#download-rfq')?.addEventListener('click', async () => {
    if (!filterId) {
      toast('Selecione um questionário para exportar');
      return;
    }
    try {
      const response = await fetch(`/api/questionnaires/${encodeURIComponent(filterId)}/export`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Falha ao exportar planilha');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] || 'rfq_export.xlsx';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      const warnings = decodeURIComponent(response.headers.get('x-export-warnings') || '');
      toast(warnings ? `Planilha baixada. Atenção: ${warnings}` : 'Planilha baixada');
    } catch (error) {
      toast(error.message);
    }
  });
  root.querySelectorAll('[data-retry-job]').forEach((button) => {
    button.addEventListener('click', async () => {
      const kind = button.dataset.jobKind;
      const path =
        kind === 'inbound'
          ? `/api/questionnaires/inbound-jobs/${encodeURIComponent(button.dataset.retryJob)}/retry`
          : `/api/questionnaires/outbound-jobs/${encodeURIComponent(button.dataset.retryJob)}/retry`;
      try {
        const result = await api(path, { method: 'POST', body: {} });
        toast(result.ok ? 'Processamento recolocado na fila' : 'Job não pode ser reenviado');
        await renderData(root, token);
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function operationsPanel(operations) {
  const failures = operations.failures || [];
  const pending = (operations.queue || [])
    .filter((item) => ['pending', 'processing', 'retry'].includes(item.status))
    .reduce((total, item) => total + Number(item.total || 0), 0);
  if (!failures.length && !pending) return '';
  return `
    <section class="card stack">
      <div class="card-head">
        <h2>Operação das filas</h2>
        <p class="muted">${pending} processamento(s) pendente(s). Envios incertos não são repetidos automaticamente.</p>
      </div>
      ${
        failures.length
          ? `<div class="stack">${failures
              .map(
                (item) => `<div class="row" style="justify-content: space-between;">
                  <div>
                    <strong>${escapeHtml(item.kind === 'inbound' ? 'Entrada' : 'Saída')} · ${escapeHtml(item.status)}</strong>
                    <div class="muted">${escapeHtml(item.error || '')}</div>
                  </div>
                  ${
                    item.status === 'uncertain'
                      ? '<span class="pill off">Revisão manual necessária</span>'
                      : `<button class="btn-ghost" type="button" data-retry-job="${escapeHtml(item.id)}" data-job-kind="${escapeHtml(item.kind)}">Tentar novamente</button>`
                  }
                </div>`,
              )
              .join('')}</div>`
          : ''
      }
    </section>`;
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
    <div class="field-block">
      <div class="field-block-head">
        <span class="field-title">Agenda</span>
      </div>
      <label>Nome</label>
      <input name="name" required value="${escapeHtml(item.name || '')}" placeholder="Acompanhamento diário" />
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
          <label>Horário</label>
          <input name="sendTime" value="${escapeHtml(item.send_time || '09:00')}" placeholder="09:00" />
        </div>
      </div>
      <label class="check"><input name="active" type="checkbox" ${item.active === 0 ? '' : 'checked'}/> Ativo</label>
    </div>`;
}

function assignFields(item = {}, contacts = []) {
  const questions =
    [...(item.questions || [])].reverse().map(questionCard).join('') || questionCard();
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
    : '<p class="muted">Nenhum contato cadastrado.</p>';

  return `
    <div class="field-block">
      <div class="field-block-head">
        <span class="field-title">Contatos</span>
      </div>
      <div class="contact-assign-list">${contactChecks}</div>
    </div>
    <div class="field-block">
      <div class="field-block-head">
        <span class="field-title">Perguntas</span>
        <button class="btn-ghost add-question" type="button">Adicionar</button>
      </div>
      <div class="stack questions">${questions}</div>
    </div>`;
}

/** Valores fixos da planilha RFQ; resposta do contato sobrescreve. */
function defaultValuesFields(item = {}) {
  const defaults = item.defaultValues || {};
  const fields = (rfqFields || [])
    .map((field) => {
      const value = defaults[field.key] || '';
      return `
        <div>
          <label>${escapeHtml(field.header)} <span class="muted">— ${escapeHtml(field.label)}</span></label>
          <input name="default:${escapeHtml(field.key)}" value="${escapeHtml(value)}" placeholder="Opcional" autocomplete="off" />
        </div>`;
    })
    .join('');
  if (!fields) return '';
  return `
    <div class="field-block">
      <div class="field-block-head">
        <span class="field-title">Respostas padrão (RFQ)</span>
      </div>
      <p class="muted" style="margin: 0 0 10px;">Preencha campos fixos da planilha. Se o contato responder a pergunta ligada ao mesmo campo, a resposta dele prevalece.</p>
      <div class="grid-2">${fields}</div>
    </div>`;
}

function questionCard(item = {}) {
  const type = item.expected_type || 'any';
  const exportField = item.export_field || '';
  const options = TYPES.map(
    ([value, label]) => `<option value="${value}" ${value === type ? 'selected' : ''}>${label}</option>`,
  ).join('');
  const fieldOptions = [
    `<option value="">Sem campo na planilha</option>`,
    ...rfqFields.map(
      (field) =>
        `<option value="${escapeHtml(field.key)}" ${field.key === exportField ? 'selected' : ''}>${escapeHtml(
          field.header,
        )} — ${escapeHtml(field.label)}</option>`,
    ),
  ].join('');
  return `
    <article class="q-item" data-id="${escapeHtml(item.id || '')}">
      <textarea class="short" name="body" placeholder="Como foi seu dia?" required>${escapeHtml(item.body || '')}</textarea>
      <div class="q-item-meta">
        <select name="expectedType" aria-label="Tipo esperado">${options}</select>
        <select name="exportField" aria-label="Campo da planilha RFQ">${fieldOptions}</select>
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
    questions.insertAdjacentHTML('afterbegin', questionCard());
    bindQuestion(questions.firstElementChild);
  });
  questions.querySelectorAll('.q-item').forEach(bindQuestion);
  form.addEventListener('submit', (event) => save(event, id));
}

function bindQuestion(card) {
  card.querySelector('.remove-question')?.addEventListener('click', () => {
    const list = card.parentElement;
    card.remove();
    if (list && !list.querySelector('.q-item')) {
      list.insertAdjacentHTML('afterbegin', questionCard());
      bindQuestion(list.firstElementChild);
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
    exportField: card.querySelector('[name=exportField]')?.value || '',
  }));
  const contactIds = [...form.querySelectorAll('[name=contactIds]:checked')].map((input) => input.value);
  const defaultValues = {};
  for (const [key, value] of data.entries()) {
    if (!String(key).startsWith('default:')) continue;
    const field = String(key).slice('default:'.length);
    const text = String(value || '').trim();
    if (field && text) defaultValues[field] = text;
  }
  try {
    await api(id ? `/api/questionnaires/${encodeURIComponent(id)}` : '/api/questionnaires', {
      method: id ? 'PUT' : 'POST',
      body: {
        name: data.get('name'),
        greeting: form.dataset.greeting || '',
        frequency: data.get('frequency'),
        weekday: Number(data.get('weekday') || 1),
        sendTime: data.get('sendTime'),
        templateId: String(data.get('templateId') || ''),
        active: data.get('active') === 'on',
        contactIds,
        questions,
        defaultValues,
      },
    });
    editingId = '';
    toast(id ? 'Questionário salvo' : 'Questionário criado');
    await renderQuestionnaires(document.querySelector('#view'));
  } catch (error) {
    toast(error.message);
  }
}
