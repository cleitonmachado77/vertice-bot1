import { api } from '../api.js';
import { escapeHtml, formatWhen, panelLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

export async function renderEvents(root, token = getNavToken()) {
  root.innerHTML = panelLoading('Carregando eventos…');
  const data = await api('/api/events');
  if (!isNavActive(token)) return;
  const rows = data.items
    .map(
      (item) => `
      <article class="card" style="padding: 14px;">
        <div class="row" style="justify-content: space-between;">
          <strong>${escapeHtml(item.event)}</strong>
          <span class="pill ${item.status === 'reply' ? '' : 'off'}">${escapeHtml(item.status)}</span>
        </div>
        <p class="muted">${escapeHtml(formatWhen(item.created_at))} · ${escapeHtml(item.summary)}</p>
        <pre>${escapeHtml(JSON.stringify(item.result, null, 2))}</pre>
      </article>`,
    )
    .join('');
  root.innerHTML = `
    <div class="stack">
      <div class="card-head" style="margin-bottom: 4px;">
        <h2>Histórico</h2>
        <p class="muted">O que chegou da Névoa e o que o agente decidiu.</p>
      </div>
      ${rows || '<p class="muted">Nenhum evento ainda.</p>'}
    </div>`;
}
