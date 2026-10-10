import { api } from '../api.js';
import { escapeHtml, formatWhen } from '../ui.js';

let timer = 0;

export function stopOverview() {
  if (timer) clearInterval(timer);
  timer = 0;
}

export async function renderOverview(root) {
  stopOverview();
  const data = await api('/api/overview');
  root.innerHTML = `
    <div class="top">
      <div>
        <p class="kicker">Operação</p>
        <h1>Visão geral</h1>
        <p class="muted">Cada contato tem o próprio prompt, as instruções e o horário das mensagens.</p>
      </div>
    </div>
    <section class="cards" id="stats">${stats(data)}</section>
    <section class="card" style="padding: 18px;">
      <h2>Últimas conversas</h2>
      <div class="list" id="recent">${recent(data.conversations)}</div>
    </section>`;
  timer = setInterval(() => refresh().catch(() => {}), 2000);
}

async function refresh() {
  const statsEl = document.querySelector('#stats');
  const recentEl = document.querySelector('#recent');
  if (!statsEl || !recentEl) return;
  const data = await api('/api/overview');
  const nextStats = stats(data);
  const nextRecent = recent(data.conversations);
  if (statsEl.innerHTML !== nextStats) statsEl.innerHTML = nextStats;
  if (recentEl.innerHTML !== nextRecent) recentEl.innerHTML = nextRecent;
}

function stats(data) {
  return `
    <article class="card stat"><span class="muted">Contatos</span><b>${data.counts.contacts}</b></article>
    <article class="card stat"><span class="muted">Conversas</span><b>${data.counts.conversations}</b></article>
    <article class="card stat"><span class="muted">Eventos</span><b>${data.counts.events}</b></article>
    <article class="card stat"><span class="muted">Resposta automática</span><b>${data.agent.autoReply ? 'Ligada' : 'Desligada'}</b></article>`;
}

function recent(conversations) {
  const items = conversations
    .map(
      (item) => `
        <a class="person" href="#/inbox">
          <span><strong>${escapeHtml(item.contact_name || item.contact_phone || 'Conversa')}</strong><br>
          <span class="muted">${escapeHtml(item.preview || 'Sem prévia')}</span></span>
          <span class="muted">${escapeHtml(formatWhen(item.last_message_at))}</span>
        </a>`,
    )
    .join('');
  return items || '<p class="muted">Nenhuma conversa ainda.</p>';
}

