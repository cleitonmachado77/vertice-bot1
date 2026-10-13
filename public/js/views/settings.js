import { renderAgent } from './agent.js';
import { renderIntegrations } from './integrations.js';
import { renderEvents } from './events.js';

const TABS = [
  { id: 'agent', label: 'Agente', render: renderAgent },
  { id: 'integrations', label: 'Integrações', render: renderIntegrations },
  { id: 'events', label: 'Eventos', render: renderEvents },
];

export async function renderSettings(root, tab = 'agent') {
  const active = TABS.some((item) => item.id === tab) ? tab : 'agent';
  root.innerHTML = `
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
    <div id="settings-panel"></div>`;

  const panel = root.querySelector('#settings-panel');
  const current = TABS.find((item) => item.id === active) || TABS[0];
  await current.render(panel);
}
