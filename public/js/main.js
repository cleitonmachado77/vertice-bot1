import { api } from './api.js';
import { escapeHtml } from './ui.js';
import { renderOverview, stopOverview } from './views/overview.js';
import { renderAgent } from './views/agent.js';
import { renderContacts, stopContacts } from './views/contacts.js';
import { renderContact } from './views/contact.js';
import { renderInbox, stopInbox } from './views/inbox.js';
import { renderIntegrations } from './views/integrations.js';
import { renderEvents } from './views/events.js';

const routes = {
  overview: { title: 'Visão geral', render: renderOverview },
  agent: { title: 'Agente', render: renderAgent },
  contacts: { title: 'Contatos', render: renderContacts },
  inbox: { title: 'Inbox', render: renderInbox },
  integrations: { title: 'Integrações', render: renderIntegrations },
  events: { title: 'Eventos', render: renderEvents },
};

const app = document.querySelector('#app');

window.addEventListener('hashchange', () => {
  draw().catch((error) => showError(error));
});

draw().catch((error) => showError(error));

async function draw() {
  stopInbox();
  stopContacts();
  stopOverview();
  const me = await api('/api/me');
  const raw = location.hash.replace('#/', '') || 'overview';
  const contactId = raw.startsWith('contacts/') ? decodeURIComponent(raw.slice('contacts/'.length)) : '';
  const inboxFocus = raw === 'inbox' ? '' : raw.startsWith('inbox/') ? decodeURIComponent(raw.slice('inbox/'.length)) : null;
  const name = contactId ? 'contacts' : inboxFocus !== null ? 'inbox' : raw;
  if (!me.authenticated) {
    renderLogin();
    return;
  }
  const route = routes[name] || routes.overview;
  app.innerHTML = shell(name);
  document.querySelector('#menu').addEventListener('click', () => {
    document.querySelector('.topbar').classList.toggle('open');
  });
  document.querySelector('#logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: {} });
    location.hash = '#/login';
    renderLogin();
  });
  const view = document.querySelector('#view');
  if (contactId) await renderContact(view, contactId);
  else if (name === 'inbox') await renderInbox(view, inboxFocus || '');
  else await route.render(view);
}

function shell(active) {
  const links = Object.entries(routes)
    .map(
      ([key, route]) =>
        `<a class="${key === active ? 'active' : ''}" href="#/${key}">${escapeHtml(route.title)}</a>`,
    )
    .join('');
  return `
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/overview">${mark()}<strong>Vertice</strong></a>
        <button class="nav-toggle" id="menu" type="button" aria-label="Abrir menu"><span></span><span></span></button>
        <nav>
          ${links}
          <button class="nav-pill" id="logout" type="button">Sair</button>
        </nav>
      </header>
      <main class="main" id="view"></main>
    </div>`;
}

function renderLogin() {
  app.innerHTML = `
    <section class="gate">
      <header class="topbar">
        <a class="brand" href="#/overview">${mark()}<strong>Vertice</strong></a>
        <a class="nav-pill" href="#password">Entrar</a>
      </header>
      <div class="gate-body">
        <div class="gate-copy">
          <h1>Acesse o próximo nível da operação.</h1>
          <p class="lede">O painel da Vértice acompanha contatos, respostas e disparos em tempo real para decidir com mais clareza.</p>
          <p class="trust">Painel do WhatsApp da Vértice Inovação</p>
        </div>
        <form class="gate-form" id="login-form">
          <h2>Entrar</h2>
          <p class="muted">Use a senha do painel para continuar.</p>
          <label for="password">Senha do painel</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <p class="muted" id="login-error"></p>
          <button class="btn" type="submit">Entrar</button>
        </form>
      </div>
    </section>`;
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    try {
      await api('/api/login', { method: 'POST', body: { password } });
      location.hash = '#/overview';
      await draw();
    } catch (error) {
      document.querySelector('#login-error').textContent = error.message;
    }
  });
}

function showError(error) {
  app.innerHTML = `<main class="main"><h1>Não foi possível abrir o painel</h1><p>${escapeHtml(error.message)}</p></main>`;
}

function mark() {
  return '<svg class="mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="#fff"/><path d="M9 1.2a7.8 7.8 0 0 0 0 15.6 6.2 6.2 0 0 1 0-15.6z" fill="#0a0a0a"/></svg>';
}
