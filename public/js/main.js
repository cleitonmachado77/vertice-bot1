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
let drawnKey = '';

window.addEventListener('hashchange', () => {
  draw().catch((error) => showError(error));
});

draw().catch((error) => showError(error));

function currentRoute() {
  const raw = location.hash.replace('#/', '') || 'overview';
  const contactId = raw.startsWith('contacts/') ? decodeURIComponent(raw.slice('contacts/'.length)) : '';
  const inboxFocus = raw === 'inbox' ? '' : raw.startsWith('inbox/') ? decodeURIComponent(raw.slice('inbox/'.length)) : null;
  const name = contactId ? 'contacts' : inboxFocus !== null ? 'inbox' : raw;
  return { contactId, inboxFocus, name, key: `${name}|${contactId}|${inboxFocus ?? ''}` };
}

function stopViews() {
  stopInbox();
  stopContacts();
  stopOverview();
}

async function draw() {
  const me = await api('/api/me');
  const current = currentRoute();
  if (!me.authenticated) {
    stopViews();
    drawnKey = '';
    renderLogin();
    return;
  }
  if (drawnKey === current.key && document.querySelector('#view')) return;
  stopViews();
  drawnKey = current.key;
  const route = routes[current.name] || routes.overview;
  if (!document.querySelector('.shell')) {
    app.innerHTML = shell(current.name, route.title);
    const frame = document.querySelector('.shell');
    if (sessionStorage.getItem('nav-collapsed') === '1') frame.classList.add('collapsed');
    bindChrome(frame);
  } else {
    syncChrome(current.name, route.title);
  }
  const view = document.querySelector('#view');
  if (current.contactId) await renderContact(view, current.contactId);
  else if (current.name === 'inbox') await renderInbox(view, current.inboxFocus || '');
  else await route.render(view);
}

function bindChrome(frame) {
  document.querySelector('#menu').addEventListener('click', () => {
    frame.classList.toggle('nav-open');
  });
  document.querySelector('#backdrop').addEventListener('click', () => {
    frame.classList.remove('nav-open');
  });
  document.querySelector('#collapse').addEventListener('click', () => {
    const collapsed = frame.classList.toggle('collapsed');
    sessionStorage.setItem('nav-collapsed', collapsed ? '1' : '0');
  });
  const leave = async () => {
    await api('/api/logout', { method: 'POST', body: {} });
    drawnKey = '';
    location.hash = '#/login';
    renderLogin();
  };
  document.querySelector('#logout').addEventListener('click', leave);
  document.querySelector('#logout-top').addEventListener('click', leave);
}

function syncChrome(active, title) {
  document.querySelector('.shell')?.classList.toggle('is-inbox', active === 'inbox');
  const heading = document.querySelector('.page-title');
  if (heading) heading.textContent = title;
  document.querySelectorAll('.side-nav a').forEach((link) => {
    link.classList.toggle('active', link.getAttribute('href') === `#/${active}`);
  });
}

function shell(active, title) {
  const links = Object.entries(routes)
    .map(
      ([key, route]) =>
        `<a class="${key === active ? 'active' : ''}" href="#/${key}">${icon(key)}<span>${escapeHtml(route.title)}</span></a>`,
    )
    .join('');
  return `
    <div class="shell${active === 'inbox' ? ' is-inbox' : ''}">
      <aside class="sidebar">
        <div class="side-brand">
          <a class="brand" href="#/overview">${mark()}<strong>Vértice</strong></a>
          <button class="icon-btn" id="collapse" type="button" aria-label="Recolher menu">${icon('collapse')}</button>
        </div>
        <nav class="side-nav">${links}</nav>
        <div class="side-foot">
          <span class="avatar">VI</span>
          <div class="side-user"><strong>Vértice</strong><span>Painel</span></div>
          <button class="icon-btn" id="logout" type="button" aria-label="Sair">${icon('logout')}</button>
        </div>
      </aside>
      <div class="backdrop" id="backdrop"></div>
      <div class="workspace">
        <header class="topbar">
          <button class="icon-btn nav-toggle" id="menu" type="button" aria-label="Abrir menu">${icon('menu')}</button>
          <h2 class="page-title">${escapeHtml(title)}</h2>
          <button class="btn-ghost" id="logout-top" type="button">Sair</button>
        </header>
        <main class="main" id="view"></main>
      </div>
    </div>`;
}

function renderLogin() {
  drawnKey = '';
  app.innerHTML = `
    <section class="gate">
      <form class="gate-card" id="login-form">
        ${mark()}
        <h1>Entrar</h1>
        <p class="muted">Painel da Vértice Inovação. Use a senha para acompanhar conversas, contatos e disparos.</p>
        <label for="password">Senha do painel</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <p class="login-error" id="login-error"></p>
        <button class="btn" type="submit">Entrar</button>
      </form>
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
  return '<svg class="mark" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="10" fill="#111827"/><path d="M9 22.5 16 8.5l7 14" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function icon(name) {
  const paths = {
    overview:
      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    agent:
      '<path d="M12 3v2"/><circle cx="12" cy="13" r="7"/><path d="M9 13h.01M15 13h.01M9.5 16.5c.8.7 1.6 1 2.5 1s1.7-.3 2.5-1"/>',
    contacts:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="3"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a3 3 0 0 1 0 5.75"/>',
    inbox:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    integrations:
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    events:
      '<path d="M12 8v4l2.5 2.5"/><circle cx="12" cy="12" r="9"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    collapse: '<path d="M15 6l-6 6 6 6"/>',
    logout: '<path d="M9 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/><path d="M14 16l4-4-4-4"/><path d="M18 12H9"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}
