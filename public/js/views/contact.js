import { api } from '../api.js';
import { escapeHtml, formatWhen, toast, displayName } from '../ui.js';

const FREQUENCIES = [
  ['daily', 'Todos os dias'],
  ['weekdays', 'Dias úteis'],
  ['weekly', 'Um dia da semana'],
];
const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export async function renderContact(root, id) {
  const [data, templates] = await Promise.all([
    api(`/api/contacts/${encodeURIComponent(id)}`),
    api('/api/templates'),
  ]);
  const contact = data.contact;
  const name = displayName(contact.name, contact.phone);
  const options = (templates.items || [])
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.language ? ` · ${escapeHtml(item.language)}` : ''}</option>`,
    )
    .join('');
  const pending = (templates.pending || []).map((item) => escapeHtml(item.name)).join(', ');
  root.innerHTML = `
    <div class="top">
      <div>
        <p class="kicker">Contato</p>
        <h1>${escapeHtml(name || contact.phone)}</h1>
        <p class="muted">${escapeHtml(contact.phone)} ${contact.blocked ? '· bloqueado no WhatsApp' : ''}</p>
      </div>
      <div class="row">
        <a class="btn-ghost" href="#/inbox/c/${encodeURIComponent(id)}">Abrir inbox</a>
        <a class="btn-ghost" href="#/contacts">Voltar</a>
      </div>
    </div>
    <form class="split-board" id="plan-form">
      <div class="split-board-side">
      <section class="card stack" id="start-card">
        <h2>Iniciar conversa</h2>
        <p class="muted">Número novo recebe primeiro um template aprovado na Névoa. Depois a conversa segue no inbox.</p>
        ${
          options
            ? `<label>Template</label><select id="template">${options}</select><button class="btn" id="start" type="button">Enviar template</button>`
            : pending
              ? `<p class="muted">O template ${pending} está em revisão na Meta. O cadastro e os envios programados já podem ser salvos. O botão de iniciar a conversa aparece quando a Meta aprovar.</p>`
              : '<p class="muted">Nenhum template ativo neste WhatsApp. O cadastro e os envios programados já podem ser salvos; o primeiro contato só sai quando a Meta aprovar um modelo e ele aparecer na Névoa.</p>'
        }
      </section>
      <section class="card stack">
        <h2>Dados e agente</h2>
        <div class="grid-2">
          <div><label>Nome</label><input name="name" value="${escapeHtml(name)}" placeholder="Maria Souza" /></div>
          <div><label>Telefone</label><input name="phone" value="${escapeHtml(contact.phone || '')}" placeholder="+5543999999999" required /></div>
        </div>
        <label>E-mail</label>
        <input name="email" value="${escapeHtml(contact.email || '')}" placeholder="maria@email.com" />
        <p class="muted">Se o prompt ficar vazio, vale o prompt geral da página Agente. A chave do modelo também fica lá.</p>
        <label>Prompt do agente</label>
        <textarea name="prompt" placeholder="Você atende este cliente da Vértice. Seja direto e confirme o que foi combinado.">${escapeHtml(contact.prompt || '')}</textarea>
        <label>Instruções</label>
        <textarea name="instructions" placeholder="Cumprimente pelo nome, peça o retorno do dia e confirme áudio, vídeo ou foto.">${escapeHtml(contact.instructions || '')}</textarea>
        <label>Notas internas</label>
        <textarea name="notes">${escapeHtml(contact.notes || '')}</textarea>
        <label class="check"><input name="botEnabled" type="checkbox" ${contact.bot_enabled ? 'checked' : ''}/> Agente pode responder este contato</label>
        <button class="btn" type="submit">Salvar contato</button>
      </section>
      </div>
      <div class="split-board-side">
      <section class="card stack">
        <div class="row" style="justify-content: space-between;">
          <h2>Mensagens programadas</h2>
          <button class="btn-ghost" id="add-message" type="button">Adicionar mensagem</button>
        </div>
        <p class="muted">O horário é o de Brasília. A resposta do contato, em texto, áudio, vídeo ou foto, fica ligada à mensagem do dia.</p>
        <div class="stack" id="messages">${data.messages.map(messageCard).join('')}</div>
      </section>
      <section class="card">
        <h2>Envios de hoje</h2>
        <div class="list">${drawDispatches(data.dispatches)}</div>
      </section>
      </div>
    </form>`;

  const list = document.querySelector('#messages');
  list.querySelectorAll('.plan-message').forEach(bindMessage);
  document.querySelector('#add-message').addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', messageCard());
    bindMessage(list.lastElementChild);
  });
  document.querySelector('#plan-form').addEventListener('submit', (event) => save(event, id));
  const start = document.querySelector('#start');
  if (start) {
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const result = await api(`/api/contacts/${encodeURIComponent(id)}/start`, {
          method: 'POST',
          body: { templateId: document.querySelector('#template').value },
        });
        toast('Conversa iniciada');
        location.hash = `#/inbox/${encodeURIComponent(result.conversationId)}`;
      } catch (error) {
        start.disabled = false;
        toast(error.message);
      }
    });
  }
}

function messageCard(item = {}) {
  const frequency = item.frequency || 'daily';
  const options = FREQUENCIES.map(
    ([value, label]) => `<option value="${value}" ${value === frequency ? 'selected' : ''}>${label}</option>`,
  ).join('');
  const days = DAYS.map(
    (label, index) => `<option value="${index}" ${Number(item.weekday ?? 1) === index ? 'selected' : ''}>${label}</option>`,
  ).join('');
  return `
    <article class="plan-message" data-id="${escapeHtml(item.id || '')}">
      <label>Mensagem</label>
      <textarea class="short" name="body">${escapeHtml(item.body || '')}</textarea>
      <div class="grid-3">
        <div>
          <label>Frequência</label>
          <select name="frequency">${options}</select>
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
      <div class="row" style="justify-content: space-between;">
        <label class="check"><input name="active" type="checkbox" ${item.active === 0 ? '' : 'checked'}/> Ativa</label>
        <button class="btn-danger remove" type="button">Remover</button>
      </div>
    </article>`;
}

function bindMessage(card) {
  const frequency = card.querySelector('[name=frequency]');
  const day = card.querySelector('.weekday-field');
  frequency.addEventListener('change', () => {
    day.hidden = frequency.value !== 'weekly';
  });
  card.querySelector('.remove').addEventListener('click', () => card.remove());
}

function drawDispatches(items) {
  if (!items.length) return '<p class="muted">Nenhum envio hoje.</p>';
  return items
    .map(
      (item) => `
      <div class="person">
        <span><strong>${escapeHtml(item.body || 'Mensagem')}</strong><br>
        <span class="muted">${escapeHtml(item.send_time || '')} · ${escapeHtml(item.response_type ? `resposta ${item.response_type}` : item.error || item.status)}</span></span>
        <span class="muted">${escapeHtml(formatWhen(item.sent_at))}</span>
      </div>`,
    )
    .join('');
}

async function save(event, id) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const messages = [...document.querySelectorAll('.plan-message')].map((card) => ({
    id: card.dataset.id || undefined,
    body: card.querySelector('[name=body]').value,
    frequency: card.querySelector('[name=frequency]').value,
    weekday: Number(card.querySelector('[name=weekday]').value),
    sendTime: card.querySelector('[name=sendTime]').value,
    active: card.querySelector('[name=active]').checked,
  }));
  try {
    await api(`/api/contacts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        prompt: form.get('prompt'),
        instructions: form.get('instructions'),
        notes: form.get('notes'),
        name: form.get('name'),
        phone: form.get('phone'),
        email: form.get('email'),
        botEnabled: form.get('botEnabled') === 'on',
        messages,
      },
    });
    toast('Contato salvo');
    await renderContact(document.querySelector('#view'), id);
  } catch (error) {
    toast(error.message);
  }
}
