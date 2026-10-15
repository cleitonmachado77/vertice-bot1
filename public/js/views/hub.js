import { availableModules } from '../modules.js';
import { escapeHtml } from '../ui.js';

export async function renderHub(root) {
  const apps = availableModules();
  root.innerHTML = `
    <div class="hub-view">
      <header class="hub-hero">
        <img class="hub-logo" src="/logo-vertice.png" alt="Vertice WEB" />
        <h1>Vertice WEB</h1>
        <p class="hub-lead">Escolha o aplicativo que deseja abrir.</p>
      </header>
      <section class="hub-grid" aria-label="Aplicativos disponíveis">
        ${apps.map(appTile).join('') || emptyState()}
      </section>
    </div>`;
}

function appTile(mod) {
  return `
    <a class="hub-app hub-app--${escapeHtml(mod.accent || 'default')}" href="${escapeHtml(mod.href)}">
      <span class="hub-app-icon" aria-hidden="true">
        <img src="/logo-vertice.png" alt="" />
      </span>
      <span class="hub-app-body">
        <strong>${escapeHtml(mod.name)}</strong>
        <span>${escapeHtml(mod.description)}</span>
      </span>
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
