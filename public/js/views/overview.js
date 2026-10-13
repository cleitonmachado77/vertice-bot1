import { api } from '../api.js';
import { escapeHtml, formatWhen, createPoll } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

const POLL_MS = 8000;
let stopPoll = null;
let statsSig = '';
let recentSig = '';

export function stopOverview() {
  if (stopPoll) stopPoll();
  stopPoll = null;
  statsSig = '';
  recentSig = '';
}

export async function renderOverview(root, token = getNavToken()) {
  stopOverview();
  root.innerHTML = `
    <div class="view-pane">
      <div class="top">
        <div>
          <p class="kicker">Operação</p>
          <h1>Visão geral</h1>
        </div>
      </div>
      <section class="cards" id="stats">
        <article class="stat skeleton-card"></article>
        <article class="stat skeleton-card"></article>
        <article class="stat skeleton-card"></article>
        <article class="stat skeleton-card"></article>
      </section>
      <section class="card" style="padding: 18px 18px 8px;">
        <div class="card-head">
          <h2>Últimas conversas</h2>
        </div>
        <div class="list" id="recent"><p class="muted">Carregando…</p></div>
      </section>
    </div>`;

  const data = await api('/api/overview');
  if (!isNavActive(token)) return;

  const statsEl = root.querySelector('#stats');
  const recentEl = root.querySelector('#recent');
  if (statsEl) statsEl.innerHTML = stats(data);
  if (recentEl) recentEl.innerHTML = recent(data.conversations);
  statsSig = countsSig(data);
  recentSig = conversationsSig(data.conversations);
  stopPoll = createPoll(() => refresh(token), POLL_MS);
}

async function refresh(token) {
  if (!isNavActive(token)) return;
  const statsEl = document.querySelector('#stats');
  const recentEl = document.querySelector('#recent');
  if (!statsEl || !recentEl) return;
  const data = await api('/api/overview');
  if (!isNavActive(token)) return;
  const nextStats = countsSig(data);
  const nextRecent = conversationsSig(data.conversations);
  if (nextStats !== statsSig) {
    statsEl.innerHTML = stats(data);
    statsSig = nextStats;
  }
  if (nextRecent !== recentSig) {
    recentEl.innerHTML = recent(data.conversations);
    recentSig = nextRecent;
  }
}

function countsSig(data) {
  const messages = data.counts.messages ?? data.counts.events ?? 0;
  return [data.counts.contacts, data.counts.conversations, messages, data.agent.autoReply ? 1 : 0].join('|');
}

function conversationsSig(conversations) {
  return conversations
    .map((item) => [item.id, item.contact_name, item.contact_phone, item.preview, item.last_message_at].join('\u001f'))
    .join('\n');
}

function stats(data) {
  const messages = data.counts.messages ?? data.counts.events ?? 0;
  return `
    <article class="stat"><span class="muted">Contatos</span><b>${data.counts.contacts}</b><span class="hint">Cadastrados</span></article>
    <article class="stat"><span class="muted">Conversas</span><b>${data.counts.conversations}</b><span class="hint">Na operação</span></article>
    <article class="stat"><span class="muted">Mensagens</span><b>${messages}</b><span class="hint">Na operação</span></article>
    <article class="stat"><span class="muted">Resposta automática</span><b>${data.agent.autoReply ? 'Ligada' : 'Desligada'}</b><span class="hint">Estado do agente</span></article>`;
}

function recent(conversations) {
  const items = conversations
    .map(
      (item) => `
        <a class="person" href="#/inbox/${encodeURIComponent(item.id)}">
          <span><strong>${escapeHtml(item.contact_name || item.contact_phone || 'Conversa')}</strong><br>
          <span class="muted">${escapeHtml(item.preview || 'Sem prévia')}</span></span>
          <span class="muted">${escapeHtml(formatWhen(item.last_message_at))}</span>
        </a>`,
    )
    .join('');
  return items || '<p class="muted">Nenhuma conversa ainda.</p>';
}
