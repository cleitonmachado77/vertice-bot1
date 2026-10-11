import { api } from '../api.js';
import { escapeHtml, formatWhen } from '../ui.js';

let timer = 0;
let statsSig = '';
let recentSig = '';

export function stopOverview() {
  if (timer) clearInterval(timer);
  timer = 0;
  statsSig = '';
  recentSig = '';
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
    <section class="card" style="padding: 18px 18px 8px;">
      <div class="card-head">
        <h2>Últimas conversas</h2>
        <p class="muted">Atividade recente da operação</p>
      </div>
      <div class="list" id="recent">${recent(data.conversations)}</div>
    </section>`;
  statsSig = countsSig(data);
  recentSig = conversationsSig(data.conversations);
  timer = setInterval(() => refresh().catch(() => {}), 2000);
}

async function refresh() {
  const statsEl = document.querySelector('#stats');
  const recentEl = document.querySelector('#recent');
  if (!statsEl || !recentEl) return;
  const data = await api('/api/overview');
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
  return [data.counts.contacts, data.counts.conversations, data.counts.events, data.agent.autoReply ? 1 : 0].join('|');
}

function conversationsSig(conversations) {
  return conversations
    .map((item) => [item.id, item.contact_name, item.contact_phone, item.preview, item.last_message_at].join('\u001f'))
    .join('\n');
}

function stats(data) {
  return `
    <article class="stat"><span class="muted">Contatos</span><b>${data.counts.contacts}</b><span class="hint">Cadastrados</span></article>
    <article class="stat"><span class="muted">Conversas</span><b>${data.counts.conversations}</b><span class="hint">Na operação</span></article>
    <article class="stat"><span class="muted">Eventos</span><b>${data.counts.events}</b><span class="hint">Registrados</span></article>
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

