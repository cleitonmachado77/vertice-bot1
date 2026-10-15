import { api, ensureSession, invalidateSession } from './api.js';
import { escapeHtml, viewLoading } from './ui.js';
import { nextNavToken, isNavActive } from './nav.js';
import { initTheme, toggleTheme } from './theme.js';
import { mountCompanySwitcher } from './company-switcher.js';
import { renderHub } from './views/hub.js';
import { renderWebSettings } from './views/web-settings.js';
import { renderForms, tabFromSlug } from './views/forms.js';
import { renderOverview, stopOverview } from './views/overview.js';
import { renderContacts, stopContacts } from './views/contacts.js';
import { renderContact } from './views/contact.js';
import { renderQuestionnaires } from './views/questionnaires.js';
import { renderInbox, stopInbox, updateInboxHandoffBadge } from './views/inbox.js';
import { renderSettings } from './views/settings.js';

initTheme();

const botRoutes = {
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

window.addEventListener('vertice:company-changed', () => {
  drawnKey = '';
  draw().catch((error) => showError(error));
});

draw().catch((error) => showError(error));

function currentRoute() {
  const raw = location.hash.replace('#/', '') || 'web';
  if (raw === 'login') {
    return { contactId: '', inboxFocus: null, settingsTab: '', formsKind: '', name: 'login', key: 'login' };
  }
  if (raw === 'web' || raw === 'hub' || raw === 'apps' || raw === '') {
    return {
      contactId: '',
      inboxFocus: null,
      settingsTab: '',
      formsKind: '',
      formsSlug: '',
      name: 'web',
      key: 'web',
    };
  }
  if (raw === 'web/settings' || raw === 'web-settings') {
    return {
      contactId: '',
      inboxFocus: null,
      settingsTab: '',
      formsKind: '',
      formsSlug: '',
      name: 'web-settings',
      key: 'web-settings',
    };
  }
  if (raw === 'forms' || raw.startsWith('forms/')) {
    let slug = raw === 'forms' ? 'compras' : raw.slice('forms/'.length) || 'compras';
    if (slug === 'dados' || slug.startsWith('dados/')) {
      slug = slug.replace(/^dados/, 'cadastros');
      location.replace(`#/forms/${slug || 'cadastros/produtos'}`);
    }
    if (raw === 'forms') location.replace('#/forms/compras');
    const formsKind = tabFromSlug(slug);
    return {
      contactId: '',
      inboxFocus: null,
      settingsTab: '',
      formsKind,
      formsSlug: slug,
      name: 'forms',
      key: `forms|${slug}`,
    };
  }
  if (LEGACY[raw]) {
    const tab = LEGACY[raw];
    if (location.hash !== `#/settings/${tab}`) location.replace(`#/settings/${tab}`);
    return { contactId: '', inboxFocus: null, settingsTab: tab, formsKind: '', name: 'settings', key: `settings|||${tab}` };
  }
  const contactId = raw.startsWith('contacts/') ? decodeURIComponent(raw.slice('contacts/'.length)) : '';
  const inboxFocus = raw === 'inbox' ? '' : raw.startsWith('inbox/') ? decodeURIComponent(raw.slice('inbox/'.length)) : null;
  const settingsTab = raw === 'settings' ? 'agent' : raw.startsWith('settings/') ? raw.slice('settings/'.length) || 'agent' : '';
  const name = contactId ? 'contacts' : inboxFocus !== null ? 'inbox' : settingsTab ? 'settings' : raw;
  const routeName = botRoutes[name] ? name : 'web';
  return {
    contactId,
    inboxFocus,
    settingsTab,
    formsKind: '',
    name: routeName,
    key: `${routeName}|${contactId}|${inboxFocus ?? ''}|${settingsTab}`,
  };
}

function stopViews() {
  stopInbox();
  stopContacts();
  stopOverview();
}

async function draw() {
  const current = currentRoute();
  if (
    drawnKey === current.key &&
    (document.querySelector('#view') || document.querySelector('#hub-view') || document.querySelector('#forms-view'))
  ) {
    return;
  }

  const prevKey = drawnKey;
  const softForms =
    current.name === 'forms' &&
    String(prevKey).startsWith('forms|') &&
    Boolean(document.querySelector('#forms-view .forms-pane'));

  const token = nextNavToken();
  if (!softForms) stopViews();
  drawnKey = current.key;

  const me = await ensureSession();
  if (!isNavActive(token)) return;

  if (!me.authenticated) {
    stopViews();
    drawnKey = '';
    renderLogin();
    return;
  }

  if (current.name === 'login') {
    location.replace('#/web');
    return;
  }

  if (current.name === 'web') {
    mountWebChrome();
    const view = document.querySelector('#hub-view');
    if (!view || !isNavActive(token)) return;
    await renderHub(view);
    return;
  }

  if (current.name === 'web-settings') {
    mountWebChrome();
    const view = document.querySelector('#hub-view');
    if (!view || !isNavActive(token)) return;
    await renderWebSettings(view);
    return;
  }

  if (current.name === 'forms') {
    mountFormsChrome();
    const view = document.querySelector('#forms-view');
    if (!view || !isNavActive(token)) return;
    await renderForms(view, current.formsKind || 'product', token, {
      soft: softForms,
      slug: current.formsSlug || '',
    });
    return;
  }

  const route = botRoutes[current.name] || botRoutes.overview;
  mountBotChrome(current.name, route.title);
  refreshInboxHandoffBadge();

  const view = document.querySelector('#view');
  if (!view || !isNavActive(token)) return;
  if (!view.querySelector('.view-loading')) view.innerHTML = viewLoading();

  try {
    if (current.contactId) await renderContact(view, current.contactId, token);
    else if (current.name === 'inbox') await renderInbox(view, current.inboxFocus || '', token);
    else if (current.name === 'settings') await renderSettings(view, current.settingsTab || 'agent', token);
    else await route.render(view, token);
  } catch (error) {
    if (!isNavActive(token)) return;
    throw error;
  }
}

function mountWebChrome() {
  if (document.querySelector('.hub-shell') && !document.querySelector('.forms-shell')) {
    const host = document.querySelector('#company-switcher');
    if (host && !host.querySelector('[data-company-switcher], .company-switcher--empty')) {
      mountCompanySwitcher(host);
    }
    return;
  }
  app.innerHTML = `
    <div class="hub-shell">
      <header class="hub-topbar">
        <a class="hub-topbar-brand" href="#/web">
          <img src="/logo-vertice.png" alt="Vertice WEB" />
          <span>Vertice WEB</span>
        </a>
        <div class="hub-topbar-actions">
          <div id="company-switcher"></div>
          <a class="btn-ghost" href="#/web/settings">Configurações</a>
          <button class="icon-btn theme-toggle" type="button" data-theme-toggle aria-label="Alternar tema">${icon('sun')}${icon('moon')}</button>
          <button class="btn-ghost" id="logout-hub" type="button">Sair</button>
        </div>
      </header>
      <main class="hub-main" id="hub-view"></main>
    </div>`;
  document.querySelector('#logout-hub')?.addEventListener('click', leave);
  bindThemeToggles();
  mountCompanySwitcher(document.querySelector('#company-switcher'));
}

function mountFormsChrome() {
  if (document.querySelector('.forms-shell')) {
    const host = document.querySelector('#company-switcher');
    if (host && !host.querySelector('[data-company-switcher], .company-switcher--empty')) {
      mountCompanySwitcher(host);
    }
    return;
  }
  app.innerHTML = `
    <div class="forms-shell">
      <header class="forms-topbar">
        <a class="forms-topbar-brand" href="#/web" title="Voltar ao Vertice WEB">
          <img src="/logo-vertice.png" alt="Vertice Forms" />
          <span>Vertice Forms</span>
        </a>
        <div class="forms-topbar-actions">
          <div id="company-switcher"></div>
          <a class="btn-ghost" href="#/web/settings">Configurações</a>
          <button class="icon-btn theme-toggle" type="button" data-theme-toggle aria-label="Alternar tema">${icon('sun')}${icon('moon')}</button>
          <button class="btn-ghost" id="logout-forms" type="button">Sair</button>
        </div>
      </header>
      <main class="forms-main main" id="forms-view"></main>
    </div>`;
  document.querySelector('#logout-forms')?.addEventListener('click', leave);
  bindThemeToggles();
  mountCompanySwitcher(document.querySelector('#company-switcher'));
}

function mountBotChrome(active, title) {
  if (!document.querySelector('.shell') || document.querySelector('.hub-shell') || document.querySelector('.forms-shell')) {
    app.innerHTML = shell(active, title);
    const frame = document.querySelector('.shell');
    if (sessionStorage.getItem('nav-collapsed') === '1') frame.classList.add('collapsed');
    bindChrome(frame);
    return;
  }
  syncChrome(active, title);
  const existingView = document.querySelector('#view');
  if (existingView) existingView.innerHTML = viewLoading();
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
  document.querySelector('#logout').addEventListener('click', leave);
  document.querySelector('#logout-top').addEventListener('click', leave);
  bindThemeToggles();
}

async function leave() {
  await api('/api/logout', { method: 'POST', body: {} });
  invalidateSession();
  drawnKey = '';
  nextNavToken();
  stopViews();
  location.hash = '#/login';
  renderLogin();
}

function bindThemeToggles() {
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    if (button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', () => toggleTheme());
  });
  initTheme();
}

function syncChrome(active, title) {
  document.querySelector('.shell')?.classList.toggle('is-inbox', active === 'inbox');
  document.querySelector('.shell')?.classList.remove('has-thread');
  const heading = document.querySelector('.page-title');
  if (heading) heading.textContent = title;
  document.querySelectorAll('.side-nav a[data-nav]').forEach((link) => {
    link.classList.toggle('active', link.getAttribute('data-nav') === active);
  });
}

function refreshInboxHandoffBadge() {
  api('/api/conversations')
    .then((data) => {
      const waiting = (data.items || []).filter(
        (item) => Number(item.awaiting_human) === 1 || Number(item.human_unread) === 1,
      ).length;
      updateInboxHandoffBadge(waiting);
    })
    .catch(() => {});
}

function shell(active, title) {
  const links = Object.entries(botRoutes)
    .map(([key, route]) => {
      const badge =
        key === 'inbox'
          ? '<span class="nav-badge" id="inbox-handoff-badge" hidden></span>'
          : '';
      return `<a class="${key === active ? 'active' : ''}" data-nav="${key}" href="#/${key}">${icon(key)}<span>${escapeHtml(route.title)}</span>${badge}</a>`;
    })
    .join('');
  return `
    <div class="shell${active === 'inbox' ? ' is-inbox' : ''}">
      <aside class="sidebar">
        <div class="side-brand">
          <a class="brand" href="#/web" title="Voltar ao Vertice WEB"><img class="brand-logo" src="/logo-vertice.png" alt="Vertice Bot" /></a>
          <button class="icon-btn" id="collapse" type="button" aria-label="Recolher menu">${icon('collapse')}</button>
        </div>
        <nav class="side-nav">
          <a class="nav-hub" href="#/web" data-nav="web">${icon('apps')}<span>Vertice WEB</span></a>
          ${links}
        </nav>
        <div class="side-foot">
          <span class="avatar">VI</span>
          <div class="side-user"><strong>Vertice Bot</strong><span>App</span></div>
          <button class="icon-btn" id="logout" type="button" aria-label="Sair">${icon('logout')}</button>
        </div>
      </aside>
      <div class="backdrop" id="backdrop"></div>
      <div class="workspace">
        <header class="topbar">
          <button class="icon-btn nav-toggle" id="menu" type="button" aria-label="Abrir menu">${icon('menu')}</button>
          <h2 class="page-title">${escapeHtml(title)}</h2>
          <div class="topbar-actions">
            <button class="icon-btn theme-toggle" type="button" data-theme-toggle aria-label="Alternar tema">${icon('sun')}${icon('moon')}</button>
            <button class="btn-ghost" id="logout-top" type="button">Sair</button>
          </div>
        </header>
        <main class="main" id="view"></main>
      </div>
    </div>`;
}

function renderLogin() {
  drawnKey = '';
  app.innerHTML = `
    <section class="gate">
      <div class="gate-glow" aria-hidden="true"></div>
      <button class="icon-btn theme-toggle gate-theme" type="button" data-theme-toggle aria-label="Alternar tema">${icon('sun')}${icon('moon')}</button>
      <div class="gate-form-panel">
        <form class="gate-form" id="login-form">
          <div class="gate-form-head">
            <img class="gate-logo" src="/logo-vertice.png" alt="Vertice WEB" />
            <p class="gate-kicker">Vertice WEB</p>
            <h1>Acesso à plataforma</h1>
            <p class="gate-lead">Entre com a senha operacional para continuar.</p>
          </div>

          <div class="gate-form-body">
            <label class="gate-label" for="password">Senha</label>
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
            <button class="gate-submit" type="submit">Entrar</button>
          </div>

          <p class="gate-foot">Vértice Inovação · acesso restrito</p>
        </form>
      </div>
    </section>`;

  bindThemeToggles();
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
      invalidateSession();
      location.hash = '#/web';
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
    apps:
      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    collapse: '<path d="M15 6l-6 6 6 6"/>',
    logout: '<path d="M9 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/><path d="M14 16l4-4-4-4"/><path d="M18 12H9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5Z"/>',
  };
  const cls = name === 'sun' ? ' theme-icon-sun' : name === 'moon' ? ' theme-icon-moon' : '';
  return `<svg class="${cls.trim()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}
