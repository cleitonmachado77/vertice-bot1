import { api } from '../api.js';
import { escapeHtml, toast, displayName, createPoll, panelLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

const POLL_MS = 8000;
let stopPoll = null;
let listSig = '';

export function stopContacts() {
  if (stopPoll) stopPoll();
  stopPoll = null;
  listSig = '';
}

export async function renderContacts(root, token = getNavToken()) {
  stopContacts();
  root.innerHTML = `
    <div class="view-pane">
      <div class="top">
        <div>
          <p class="kicker">Pessoas</p>
          <h1>Contatos</h1>
          <p class="muted">Cadastre um número novo. Quem já falou com a Vértice entra sozinho.</p>
        </div>
      </div>
      <div class="split-board">
        <form class="card stack" id="new-contact">
          <h2>Novo contato</h2>
          <div><label>Nome</label><input name="name" required placeholder="Maria Souza" /></div>
          <div><label>Telefone</label><input name="phone" required placeholder="+5543999999999" /></div>
          <div><label>E-mail</label><input name="email" type="email" placeholder="maria@email.com" /></div>
          <button class="btn" type="submit">Cadastrar</button>
        </form>
        <div class="split-board-side">
          <input id="search" placeholder="Buscar nome ou telefone" />
          <div class="stack" id="contact-list">${panelLoading('Carregando contatos…')}</div>
        </div>
      </div>
    </div>`;

  document.querySelector('#contact-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-remove]');
    if (!button) return;
    removeContact(button.dataset.remove, token);
  });
  document.querySelector('#new-contact').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await api('/api/contacts', {
        method: 'POST',
        body: { name: form.get('name'), phone: form.get('phone'), email: form.get('email') },
      });
      const conversationId = created.conversationId;
      location.hash = conversationId
        ? `#/inbox/${encodeURIComponent(conversationId)}`
        : `#/inbox/c/${encodeURIComponent(created.contact.id)}`;
    } catch (error) {
      toast(error.message);
    }
  });
  document.querySelector('#search').addEventListener('input', async (event) => {
    await paintList(event.target.value, token);
  });

  await paintList('', token);
  if (!isNavActive(token)) return;
  stopPoll = createPoll(() => {
    const search = document.querySelector('#search');
    return paintList(search ? search.value : '', token);
  }, POLL_MS);
}

async function paintList(query, token = getNavToken()) {
  if (!isNavActive(token)) return;
  const list = document.querySelector('#contact-list');
  if (!list) return;
  const result = await api(`/api/contacts?q=${encodeURIComponent(query || '')}`);
  if (!isNavActive(token)) return;
  const next = itemsSig(result.items);
  if (next === listSig && !list.querySelector('.panel-loading')) return;
  listSig = next;
  list.innerHTML = draw(result.items);
}

async function removeContact(id, token = getNavToken()) {
  if (!window.confirm('Excluir este contato da lista?')) return;
  try {
    await api(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    listSig = '';
    const search = document.querySelector('#search');
    await paintList(search ? search.value : '', token);
    toast('Contato excluído');
  } catch (error) {
    toast(error.message);
  }
}

function itemsSig(items) {
  return items
    .map((item) => [item.id, item.name, item.phone, item.message_count, item.bot_enabled ? 1 : 0, item.blocked ? 1 : 0].join('\u001f'))
    .join('\n');
}

function draw(items) {
  if (!items.length) return '<p class="muted">Nenhum contato ainda.</p>';
  return items
    .map((item) => {
      const title = displayName(item.name, item.phone) || item.phone;
      const count = Number(item.message_count || 0);
      const messages = count === 1 ? '1 mensagem' : `${count} mensagens`;
      return `
        <article class="card">
          <div class="row" style="justify-content: space-between;">
            <strong>${escapeHtml(title)}</strong>
            <span class="pill ${item.bot_enabled ? '' : 'off'}">${item.bot_enabled ? 'Agente ligado' : 'Agente pausado'}</span>
          </div>
          <p class="muted">${escapeHtml(item.phone)} · ${messages}${item.blocked ? ' · bloqueado no WhatsApp' : ''}</p>
          <div class="row">
            <a class="btn" href="#/inbox/c/${encodeURIComponent(item.id)}">Conversar</a>
            <a class="btn-ghost" href="#/contacts/${encodeURIComponent(item.id)}">Configurar</a>
            <button type="button" class="btn-danger" data-remove="${escapeHtml(item.id)}">Excluir</button>
          </div>
        </article>`;
    })
    .join('');
}
