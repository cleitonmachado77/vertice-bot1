import { api } from './api.js';
import { escapeHtml } from './ui.js';
import { renderOverview, stopOverview } from './views/overview.js';
import { renderContacts, stopContacts } from './views/contacts.js';
import { renderContact } from './views/contact.js';
import { renderQuestionnaires } from './views/questionnaires.js';
import { renderInbox, stopInbox } from './views/inbox.js';
import { renderSettings } from './views/settings.js';

const routes = {
  overview: { title: 'Visão geral', render: renderOverview },
  inbox: { title: 'Inbox', render: renderInbox },
  contacts: { title: 'Contatos', render: renderContacts },
  questionnaires: { title: 'Questionários', render: renderQuestionnaires },
  settings: { title: 'Configurações', render: renderSettings },
};

const LEGACY = {
  agent: 'agent',
  integrations: 'integrations',
  events: 'events',
};

const app = document.querySelector('#app');
let drawnKey = '';

window.addEventListener('hashchange', () => {
  draw().catch((error) => showError(error));
});

draw().catch((error) => showError(error));

function currentRoute() {
  const raw = location.hash.replace('#/', '') || 'overview';
  if (LEGACY[raw]) {
    const tab = LEGACY[raw];
    if (location.hash !== `#/settings/${tab}`) location.replace(`#/settings/${tab}`);
    return { contactId: '', inboxFocus: null, settingsTab: tab, name: 'settings', key: `settings|||${tab}` };
  }
  const contactId = raw.startsWith('contacts/') ? decodeURIComponent(raw.slice('contacts/'.length)) : '';
  const inboxFocus = raw === 'inbox' ? '' : raw.startsWith('inbox/') ? decodeURIComponent(raw.slice('inbox/'.length)) : null;
  const settingsTab = raw === 'settings' ? 'agent' : raw.startsWith('settings/') ? raw.slice('settings/'.length) || 'agent' : '';
  const name = contactId ? 'contacts' : inboxFocus !== null ? 'inbox' : settingsTab ? 'settings' : raw;
  return {
    contactId,
    inboxFocus,
    settingsTab,
    name,
    key: `${name}|${contactId}|${inboxFocus ?? ''}|${settingsTab}`,
  };
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
  else if (current.name === 'settings') await renderSettings(view, current.settingsTab || 'agent');
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
          <a class="brand" href="#/overview"><img class="brand-logo" src="/logo-vertice.png" alt="Vértice Bot" /></a>
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
      <div class="gate-form-panel">
        <form class="gate-form" id="login-form">
          <div class="gate-form-head">
            <img class="gate-logo" src="/logo-vertice.png" alt="Vértice Bot" />
            <p class="gate-kicker">Painel operacional</p>
            <h1>Entrar</h1>
          </div>

          <div class="gate-form-body">
            <label class="gate-label" for="password">Senha do painel</label>
            <div class="gate-field">
              <span class="gate-field-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="5" y="11" width="14" height="10" rx="2"/>
                  <path d="M8 11V8a4 4 0 0 1 8 0v3"/>
                </svg>
              </span>
              <input
                id="password"
                name="password"
                type="password"
                placeholder="Digite sua senha"
                autocomplete="current-password"
                required
              />
              <button class="gate-eye" type="button" id="toggle-password" aria-label="Mostrar senha">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
            </div>
            <p class="login-error" id="login-error"></p>
            <button class="gate-submit" type="submit">Acessar painel</button>
          </div>

          <p class="gate-foot">Vértice Inovação · acesso restrito</p>
        </form>
      </div>

      <aside class="gate-visual" aria-hidden="true">
        <img class="gate-visual-image" src="/login1.png" alt="" />
      </aside>
    </section>`;

  const passwordInput = document.querySelector('#password');
  document.querySelector('#toggle-password')?.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    document.querySelector('#toggle-password').setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  });

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    const submit = event.currentTarget.querySelector('.gate-submit');
    submit.disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: { password } });
      location.hash = '#/overview';
      await draw();
    } catch (error) {
      submit.disabled = false;
      document.querySelector('#login-error').textContent = error.message;
    }
  });
}

function showError(error) {
  app.innerHTML = `<main class="main"><h1>Não foi possível abrir o painel</h1><p>${escapeHtml(error.message)}</p></main>`;
}

function icon(name) {
  const paths = {
    overview:
      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    contacts:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="3"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a3 3 0 0 1 0 5.75"/>',
    questionnaires:
      '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/>',
    inbox:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    collapse: '<path d="M15 6l-6 6 6 6"/>',
    logout: '<path d="M9 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/><path d="M14 16l4-4-4-4"/><path d="M18 12H9"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}
