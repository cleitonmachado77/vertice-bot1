import { api } from '../api.js';
import { escapeHtml, formatWhen } from '../ui.js';

export async function renderEvents(root) {
  const data = await api('/api/events');
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
    <div class="top"><div><p class="kicker">Histórico</p><h1>Eventos</h1><p class="muted">O que chegou da Névoa e o que o agente decidiu.</p></div></div>
    <div class="stack">${rows || '<p class="muted">Nenhum evento ainda.</p>'}</div>`;
}
