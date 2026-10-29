import { renderAgent } from './agent.js';
import { renderBotMenu } from './bot-menu.js';
import { renderIntegrations } from './integrations.js';
import { renderEvents } from './events.js';
import { getNavToken, isNavActive } from '../nav.js';
import { panelLoading } from '../ui.js';

const TABS = [
  { id: 'agent', label: 'Agente', render: renderAgent },
  { id: 'menu', label: 'Menu', render: renderBotMenu },
  { id: 'integrations', label: 'Integrações', render: renderIntegrations },
  { id: 'events', label: 'Eventos', render: renderEvents },
];

export async function renderSettings(root, tab = 'agent', token = getNavToken()) {
  const active = TABS.some((item) => item.id === tab) ? tab : 'agent';
  root.innerHTML = `
    <div class="view-pane">
      <div class="top">
        <div>
          <p class="kicker">Painel</p>
          <h1>Configurações</h1>
        </div>
      </div>
      <nav class="settings-tabs" aria-label="Seções de configuração">
        ${TABS.map(
          (item) =>
            `<a class="settings-tab${item.id === active ? ' active' : ''}" href="#/settings/${item.id}">${item.label}</a>`,
        ).join('')}
      </nav>
      <div id="settings-panel">${panelLoading()}</div>
    </div>`;

  if (!isNavActive(token)) return;
  const panel = root.querySelector('#settings-panel');
  const current = TABS.find((item) => item.id === active) || TABS[0];
  await current.render(panel, token);
}
