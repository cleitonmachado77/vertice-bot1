import { availableModules } from '../modules.js';
import { escapeHtml } from '../ui.js';

export async function renderHub(root) {
  const apps = availableModules();
  root.innerHTML = `
    <div class="hub-view">
      <header class="hub-hero">
        <span class="hub-logo-wrap">
          <img class="hub-logo" src="/logo-vertice-web.png" alt="Vertice WEB" />
        </span>
      </header>
      <section class="hub-grid" aria-label="Aplicativos disponíveis">
        ${apps.map(appTile).join('') || emptyState()}
      </section>
    </div>`;
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
