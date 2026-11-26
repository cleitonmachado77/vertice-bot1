import { isHubDashboardAvailable } from '../company-switcher.js';
import { icon } from '../icons.js';
import { availableModules } from '../modules.js';
import { escapeHtml } from '../ui.js';
import {
  mountHubDashboard,
  renderDashboardShell,
  renderDashboardStats,
  renderPeriodPicker,
  stopHubDashboard,
} from './hub-dashboard.js';

export { stopHubDashboard };

/**
 * Vértice Elo (#/web):
 * - Reciclarenda: dashboard consolidado.
 * - Outras entidades: página institucional com os módulos disponíveis.
 */
export async function renderHub(root, me = null) {
  if (isHubDashboardAvailable()) {
    await renderDashboardView(root, {
      title: 'Indicadores do período',
      scope: 'hub',
    });
    return;
  }
  renderHubHome(root, me);
}

/** Dashboard do módulo Vértice RSU, filtrado pela entidade ativa. */
export async function renderRsuDashboard(root, me = null) {
  await renderDashboardView(root, {
    title: 'Indicadores RSU',
    scope: 'entity',
    me,
  });
}

async function renderDashboardView(root, { title, scope }) {
  stopHubDashboard();
  const now = new Date();

  root.innerHTML = `
    <div class="view-pane hub-view">
      <div class="page-head hub-head">
        ${renderPeriodPicker({ month: now.getMonth() + 1, year: now.getFullYear() })}
      </div>

      ${renderDashboardStats()}

      <h2 class="section-title">${escapeHtml(title)}</h2>
      ${renderDashboardShell()}
    </div>`;

  await mountHubDashboard(root, { scope });
}

/** Página inicial institucional para entidades (sem o dashboard consolidado). */
function renderHubHome(root, me = null) {
  stopHubDashboard();
  const isAdm = Boolean(me?.isAdm || me?.user?.role === 'adm');
  const name = me?.user?.name || String(me?.user?.email || '').split('@')[0];
  const apps = availableModules().filter((mod) => isAdm || mod.id !== 'bot');

  root.innerHTML = `
    <div class="view-pane hub-view">
      <header class="hub-hero">
        <p class="hub-hero-kicker">Vértice Elo</p>
        <h1>Olá${name ? `, ${escapeHtml(name)}` : ''}</h1>
      </header>

      <h2 class="section-title">Módulos disponíveis</h2>
      <section class="hub-apps" aria-label="Módulos disponíveis">
        ${apps.map((mod) => appTile(mod)).join('') || '<p class="hub-empty">Nenhum módulo disponível no momento.</p>'}
      </section>
    </div>`;
}

function appTile(mod) {
  const logo = mod.logo || '/logo-vertice-elo.png';
  return `
    <a class="hub-app hub-app--${escapeHtml(mod.accent || 'default')}" href="${escapeHtml(mod.href)}" aria-label="${escapeHtml(mod.name)}">
      <span class="hub-app-body">
        <img class="hub-app-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(mod.name)}" />
        ${mod.description ? `<p class="hub-app-desc">${escapeHtml(mod.description)}</p>` : ''}
      </span>
      <span class="hub-app-go" aria-hidden="true">${icon('chevron')}</span>
    </a>`;
}
