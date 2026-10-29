import { api, ensureSession, invalidateSession } from './api.js';
import { escapeHtml, initials, viewLoading } from './ui.js';
import { icon } from './icons.js';
import { nextNavToken, isNavActive } from './nav.js';
import { initTheme } from './theme.js';
import { clearCompaniesCache, mountCompanySwitcher, mountEntityBadge } from './company-switcher.js';
import { renderHub, stopHubDashboard } from './views/hub.js';
import { renderWebSettings } from './views/web-settings.js';
import { FORMS_TABS, renderForms, tabFromSlug } from './views/forms.js';
import { renderOverview, stopOverview } from './views/overview.js';
import { renderContacts, stopContacts } from './views/contacts.js';
import { renderContact } from './views/contact.js';
import { renderQuestionnaires } from './views/questionnaires.js';
import { renderInbox, stopInbox, updateInboxHandoffBadge } from './views/inbox.js';
import { renderSettings } from './views/settings.js';

initTheme();

const botRoutes = {
  overview: { title: 'Visão geral', render: renderOverview, icon: 'dashboard' },
  inbox: { title: 'Inbox', render: renderInbox, icon: 'inbox' },
  contacts: { title: 'Contatos', render: renderContacts, icon: 'contacts' },
  questionnaires: { title: 'Análise', render: renderQuestionnaires, icon: 'questionnaires' },
  settings: { title: 'Configurações', render: renderSettings, icon: 'settings' },
};

const APPS = {
  web: {
    crumb: 'Vertice WEB',
    logo: '/logo-vertice-web.png',
    shellClass: 'hub-shell',
    mainClass: 'main hub-main',
    mainId: 'hub-view',
  },
  forms: {
    crumb: 'Vertice Forms',
    logo: '/logo-vertice-forms.png',
    shellClass: 'forms-shell',
    mainClass: 'main forms-main',
    mainId: 'forms-view',
  },
  bot: {
    crumb: 'Vertice Bot',
    logo: '/logo-vertice-bot.png',
    shellClass: 'bot-shell',
    mainClass: 'main',
    mainId: 'view',
  },
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
  if (raw === 'web/settings' || raw === 'web-settings' || raw.startsWith('web/settings/')) {
    const settingsTab =
      raw === 'web/settings' || raw === 'web-settings'
        ? 'usuarios'
        : decodeURIComponent(raw.slice('web/settings/'.length) || 'usuarios') || 'usuarios';
    return {
      contactId: '',
      inboxFocus: null,
      settingsTab,
      formsKind: '',
      formsSlug: '',
      name: 'web-settings',
      key: `web-settings|${settingsTab}`,
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
  stopHubDashboard();
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
    mountChrome('web', me, 'web', 'Dashboard');
    const view = document.querySelector('#hub-view');
    if (!view || !isNavActive(token)) return;
    await renderHub(view, me);
    return;
  }

  if (current.name === 'web-settings') {
    if (!isAdmSession(me)) {
      location.replace('#/web');
      return;
    }
    mountChrome('web', me, 'web-settings', 'Configurações');
    const view = document.querySelector('#hub-view');
    if (!view || !isNavActive(token)) return;
    await renderWebSettings(view, me, current.settingsTab || 'usuarios');
    return;
  }

  if (current.name === 'forms') {
    const formsKind = current.formsKind || 'product';
    const formsTab = FORMS_TABS.find((tab) => tab.id === formsKind);
    mountChrome('forms', me, formsKind, formsTab?.label || 'Vertice Forms');
    const view = document.querySelector('#forms-view');
    if (!view || !isNavActive(token)) return;
    await renderForms(view, current.formsKind || 'product', token, {
      soft: softForms,
      slug: current.formsSlug || '',
    });
    return;
  }

  if (!isAdmSession(me)) {
    location.replace('#/web');
    return;
  }

  const route = botRoutes[current.name] || botRoutes.overview;
  mountBotChrome(me, current.name, route.title);
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

function isAdmSession(me) {
  return Boolean(me?.isAdm || me?.user?.role === 'adm');
}

function navItems(appKey, me) {
  if (appKey === 'web') {
    const adm = isAdmSession(me);
    return [
      { key: 'web', href: '#/web', label: 'Dashboard', icon: 'dashboard' },
      adm && { key: 'bot', href: '#/overview', label: 'Vertice Bot', icon: 'bot' },
      { key: 'forms', href: '#/forms/compras', label: 'Vertice Forms', icon: 'forms' },
      adm && { key: 'web-settings', href: '#/web/settings/usuarios', label: 'Configurações', icon: 'settings' },
    ].filter(Boolean);
  }
  if (appKey === 'forms') {
    return FORMS_TABS.map((tab) => ({ key: tab.id, href: tab.href, label: tab.label, icon: tab.icon }));
  }
  return Object.entries(botRoutes).map(([key, route]) => ({
    key,
    href: `#/${key}`,
    label: route.title,
    icon: route.icon,
    badge: key === 'inbox' ? '<span class="nav-badge" id="inbox-handoff-badge" hidden></span>' : '',
  }));
}

function navLinkHtml(item, active) {
  return `<a class="${item.key === active ? 'active' : ''}" data-nav="${escapeHtml(item.key)}" href="${escapeHtml(item.href)}" title="${escapeHtml(item.label)}">${icon(item.icon)}<span>${escapeHtml(item.label)}</span>${item.badge || ''}</a>`;
}

function sideFootHtml(me) {
  const user = me?.user || {};
  const name = user.name || user.email || 'Usuário';
  const role = user.role === 'adm' ? 'Administrador' : 'Gestor Entidade';
  return `
        <div class="side-foot">
          <div class="side-user-row" title="${escapeHtml(user.email || name)}">
            <span class="avatar">${escapeHtml(initials(name))}</span>
            <div class="side-user"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(role)}</span></div>
          </div>
          <button class="side-logout" id="logout" type="button" title="Sair">${icon('logout')}<span>Sair</span></button>
        </div>`;
}

function topbarActionsHtml(me) {
  if (!isAdmSession(me)) return '<div id="entity-badge"></div>';
  return `
            <div id="company-switcher"></div>
            <a class="icon-btn" href="#/web/settings/usuarios" data-settings-link title="Configurações do Vertice WEB" aria-label="Configurações">${icon('settings')}</a>`;
}

function mountTopbarControls(me) {
  const actions = document.querySelector('#topbar-actions');
  if (!actions) return;
  const adm = isAdmSession(me);
  let host = actions.querySelector(adm ? '#company-switcher' : '#entity-badge');
  if (!host) {
    actions.innerHTML = topbarActionsHtml(me);
    host = actions.querySelector(adm ? '#company-switcher' : '#entity-badge');
  }
  if (!adm) {
    mountEntityBadge(host, me);
    return;
  }
  if (!host.querySelector('[data-company-switcher], .company-switcher--empty')) {
    mountCompanySwitcher(host, me);
  }
}

/** Monta (ou reaproveita) a casca com sidebar. Retorna true quando a casca foi recriada. */
function mountChrome(appKey, me, active, title) {
  const current = document.querySelector('.shell');
  if (current && current.dataset.app === appKey) {
    syncChrome(active, title);
    mountTopbarControls(me);
    return false;
  }
  const cfg = APPS[appKey];
  const hubLink =
    appKey === 'web'
      ? ''
      : `<a class="nav-hub" href="#/web" data-nav="hub" title="Voltar ao Vertice WEB">${icon('apps')}<span>Vertice WEB</span></a>`;
  const collapsed = sessionStorage.getItem('nav-collapsed') === '1';
  app.innerHTML = `
    <div class="shell ${cfg.shellClass}${collapsed ? ' collapsed' : ''}" data-app="${appKey}">
      <aside class="sidebar">
        <button class="sidebar-toggle" id="collapse" type="button" aria-label="Recolher menu">${icon('collapse')}</button>
        <div class="side-brand">
          <a class="brand" href="#/web" title="Vertice WEB"><img class="brand-logo" src="${cfg.logo}" alt="${escapeHtml(cfg.crumb)}" /></a>
        </div>
        <nav class="side-nav">
          ${hubLink}
          ${navItems(appKey, me).map((item) => navLinkHtml(item, active)).join('')}
        </nav>
        ${sideFootHtml(me)}
      </aside>
      <div class="backdrop" id="backdrop"></div>
      <div class="workspace">
        <header class="topbar">
          <button class="icon-btn nav-toggle" id="menu" type="button" aria-label="Abrir menu">${icon('menu')}</button>
          <div class="topbar-title">
            <span class="topbar-crumb">${escapeHtml(cfg.crumb)}</span>
            <h2 class="page-title">${escapeHtml(title)}</h2>
          </div>
          <div class="topbar-actions" id="topbar-actions">${topbarActionsHtml(me)}</div>
        </header>
        <main class="${cfg.mainClass}" id="${cfg.mainId}"></main>
      </div>
    </div>`;
  const frame = document.querySelector('.shell');
  bindChrome(frame);
  syncChrome(active, title);
  mountTopbarControls(me);
  return true;
}

function mountBotChrome(me, active, title) {
  const fresh = mountChrome('bot', me, active, title);
  if (fresh) return;
  const existingView = document.querySelector('#view');
  if (existingView) existingView.innerHTML = viewLoading();
}

function bindChrome(frame) {
  frame.querySelector('#menu').addEventListener('click', () => {
    frame.classList.toggle('nav-open');
  });
  frame.querySelector('#backdrop').addEventListener('click', () => {
    frame.classList.remove('nav-open');
  });
  frame.querySelector('#collapse').addEventListener('click', () => {
    const collapsed = frame.classList.toggle('collapsed');
    sessionStorage.setItem('nav-collapsed', collapsed ? '1' : '0');
  });
  frame.querySelector('.side-nav').addEventListener('click', (event) => {
    if (event.target.closest('a')) frame.classList.remove('nav-open');
  });
  frame.querySelector('#logout').addEventListener('click', leave);
}

async function leave() {
  await api('/api/logout', { method: 'POST', body: {} });
  invalidateSession();
  clearCompaniesCache();
  drawnKey = '';
  nextNavToken();
  stopViews();
  location.hash = '#/login';
  renderLogin();
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

function renderLogin() {
  drawnKey = '';
  app.innerHTML = `
    <section class="gate">
      <div class="gate-form-panel">
        <div class="gate-brand">
          <img class="gate-logo" src="/logo-vertice-marca.png" alt="Vértice" />
        </div>
        <form class="gate-form" id="login-form">
          <div class="gate-form-head">
            <p class="gate-kicker">Vertice WEB</p>
            <h1>Acesse sua conta</h1>
            <p class="gate-lead">Entre com seu e-mail e senha</p>
          </div>

          <div class="gate-form-body">
            <label class="gate-label" for="email">E-mail</label>
            <div class="gate-field">
              <span class="gate-field-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="3" y="5" width="18" height="14" rx="2"/>
                  <path d="m3 7 9 6 9-6"/>
                </svg>
              </span>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="seu@email.com"
                autocomplete="username"
                required
              />
            </div>

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

          <p class="gate-foot">Vértice Inovação · ADM ou Gestor Entidade</p>
        </form>
      </div>
    </section>`;

  const passwordInput = document.querySelector('#password');
  document.querySelector('#toggle-password')?.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    document.querySelector('#toggle-password').setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  });

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = form.get('password');
    const submit = event.currentTarget.querySelector('.gate-submit');
    submit.disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: { email, password } });
      invalidateSession();
      clearCompaniesCache();
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
