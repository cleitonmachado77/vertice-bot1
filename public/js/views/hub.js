import { availableModules } from '../modules.js';
import { escapeHtml } from '../ui.js';
import { mountHubDashboard, renderDashboardShell, stopHubDashboard } from './hub-dashboard.js';

export { stopHubDashboard };

export async function renderHub(root, me = null) {
  stopHubDashboard();
  const isAdm = Boolean(me?.isAdm || me?.user?.role === 'adm');
  const apps = availableModules().filter((mod) => isAdm || mod.id !== 'bot');
  const now = new Date();

  root.innerHTML = `
    <div class="hub-view hub-view--dashboard">
      <div class="hub-layout">
        ${renderDashboardShell({ month: now.getMonth() + 1, year: now.getFullYear() })}
        <aside class="hub-apps-col" aria-label="Aplicativos">
          <span class="hub-logo-wrap">
            <img class="hub-logo" src="/logo-vertice-web.png" alt="Vertice WEB" />
          </span>
          <section class="hub-grid hub-grid--side" aria-label="Aplicativos disponíveis">
            ${apps.map((mod) => appTile(mod)).join('') || emptyState()}
          </section>
        </aside>
      </div>
    </div>`;

  await mountHubDashboard(root);
}

function appTile(mod) {
  const logo = mod.logo || '/logo-vertice.png';
  return `
    <a class="hub-app hub-app--${escapeHtml(mod.accent || 'default')}" href="${escapeHtml(mod.href)}" aria-label="${escapeHtml(mod.name)}">
      <img class="hub-app-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(mod.name)}" />
      <span class="hub-app-go" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6"/>
        </svg>
      </span>
    </a>`;
}

function emptyState() {
  return `<p class="hub-empty">Nenhum aplicativo disponível no momento.</p>`;
}
