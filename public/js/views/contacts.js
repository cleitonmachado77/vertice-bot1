import { api } from '../api.js';
import { escapeHtml, toast, displayName } from '../ui.js';

let timer = 0;
let listSig = '';

export function stopContacts() {
  if (timer) clearInterval(timer);
  timer = 0;
  listSig = '';
}

export async function renderContacts(root) {
  stopContacts();
  const data = await api('/api/contacts');
  root.innerHTML = `
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
        <input id="search" placeholder="Buscar nome, telefone ou nota" />
        <div class="stack" id="contact-list">${draw(data.items)}</div>
      </div>
    </div>`;
  listSig = itemsSig(data.items);
  document.querySelector('#new-contact').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await api('/api/contacts', {
        method: 'POST',
        body: { name: form.get('name'), phone: form.get('phone'), email: form.get('email') },
      });
      location.hash = `#/contacts/${encodeURIComponent(created.contact.id)}`;
    } catch (error) {
      toast(error.message);
    }
  });
  document.querySelector('#search').addEventListener('input', async (event) => {
    await paintList(event.target.value);
  });
  timer = setInterval(() => {
    const search = document.querySelector('#search');
    paintList(search ? search.value : '').catch(() => {});
  }, 2000);
}

async function paintList(query) {
  const list = document.querySelector('#contact-list');
  if (!list) return;
  const result = await api(`/api/contacts?q=${encodeURIComponent(query || '')}`);
  const next = itemsSig(result.items);
  if (next === listSig) return;
  listSig = next;
  list.innerHTML = draw(result.items);
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
          </div>
        </article>`;
    })
    .join('');
}
