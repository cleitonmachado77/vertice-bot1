import { availableModules } from '../modules.js';
import { icon } from '../icons.js';
import { actionCard, escapeHtml } from '../ui.js';
import {
  mountHubDashboard,
  renderDashboardShell,
  renderDashboardStats,
  renderPeriodPicker,
  stopHubDashboard,
} from './hub-dashboard.js';

export { stopHubDashboard };

export async function renderHub(root, me = null) {
  stopHubDashboard();
  const isAdm = Boolean(me?.isAdm || me?.user?.role === 'adm');
  const apps = availableModules().filter((mod) => isAdm || mod.id !== 'bot');
  const now = new Date();
  const name = me?.user?.name || String(me?.user?.email || '').split('@')[0];

  root.innerHTML = `
    <div class="view-pane hub-view">
      <div class="page-head hub-head">
        <div>
          <h1>Olá${name ? `, ${escapeHtml(name)}` : ''}</h1>
          <p class="muted">Bem-vindo ao Vertice WEB. O que deseja fazer hoje?</p>
        </div>
        ${renderPeriodPicker({ month: now.getMonth() + 1, year: now.getFullYear() })}
      </div>

      ${renderDashboardStats()}

      <h2 class="section-title">Aplicativos</h2>
      <section class="hub-apps" aria-label="Aplicativos disponíveis">
        ${apps.map((mod) => appTile(mod)).join('') || emptyState()}
      </section>

      <h2 class="section-title">Ações rápidas</h2>
      <section class="action-grid" aria-label="Ações rápidas">
        ${quickActions(isAdm).map((item) => actionCard(item)).join('')}
      </section>

      <h2 class="section-title">Indicadores do período</h2>
      ${renderDashboardShell()}
    </div>`;

  await mountHubDashboard(root);
}

function quickActions(isAdm) {
  return [
    { href: '#/forms/compras', title: 'Compras', description: 'Solicitações de cotação e pedidos de compra', icon: 'cart', tone: 'orange' },
    { href: '#/forms/vendas', title: 'Vendas', description: 'Cotações e pedidos de venda', icon: 'sales', tone: 'blue' },
    { href: '#/forms/fabricacao', title: 'Fabricação', description: 'Registrar produção e prensagem', icon: 'factory', tone: 'teal' },
    { href: '#/forms/inventario', title: 'Inventário', description: 'Produtos e controle de estoque', icon: 'box', tone: 'violet' },
    { href: '#/forms/cadastros/produtos', title: 'Cadastros', description: 'Produtos, clientes e fornecedores do Odoo', icon: 'folder', tone: 'amber' },
    isAdm && { href: '#/inbox', title: 'Inbox do Bot', description: 'Conversas e atendimento humano no WhatsApp', icon: 'inbox', tone: 'green' },
  ].filter(Boolean);
}

function appTile(mod) {
  const logo = mod.logo || '/logo-vertice.png';
  return `
    <a class="hub-app hub-app--${escapeHtml(mod.accent || 'default')}" href="${escapeHtml(mod.href)}" aria-label="${escapeHtml(mod.name)}">
      <span class="hub-app-body">
        <img class="hub-app-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(mod.name)}" />
        ${mod.description ? `<p class="hub-app-desc">${escapeHtml(mod.description)}</p>` : ''}
      </span>
      <span class="hub-app-go" aria-hidden="true">${icon('chevron')}</span>
    </a>`;
}

function emptyState() {
  return `<p class="hub-empty">Nenhum aplicativo disponível no momento.</p>`;
}
