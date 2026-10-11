import { api } from '../api.js';
import { escapeHtml, formatClock, initials, toast } from '../ui.js';

const ORIGIN = {
  contact: 'Contato',
  manual: 'Manual',
  agent: 'Agente',
  scheduled: 'Programada',
  whatsapp: 'WhatsApp',
};

const LOCAL_MS = 2000;
const NEVOA_MS = 2000;

let selected = '';
let watchToken = 0;
let timers = [];
let pulling = false;
let lastPull = 0;
let painted = '';
let listPainted = '';
let shownId = '';
let snapshot = { items: [], conversation: null };
let pending = [];
let sends = 0;

export function stopInbox() {
  watchToken += 1;
  for (const timer of timers) clearInterval(timer);
  timers = [];
  pulling = false;
}

export async function renderInbox(root, focus = '') {
  stopInbox();
  const data = await api('/api/conversations');
  root.innerHTML = `
    <section class="split">
      <aside class="wa-list">
        <div class="wa-list-head">
          <h2>Conversas</h2>
          <input id="conv-search" type="search" placeholder="Pesquisar conversa" />
        </div>
        <div class="wa-scroll" id="conv-list">${drawList(data.items)}</div>
      </aside>
      <div class="thread" id="thread">${emptyThread()}</div>
    </section>`;
  listPainted = listKey(data.items);
  document.querySelector('#conv-search').addEventListener('input', applySearch);
  bindList(root);
  syncThreadMode();
  if (focus.startsWith('c/')) await openContact(focus.slice(2));
  else if (focus) await openConversation(focus);
  else if (selected) await openConversation(selected);
  startWatch(root);
}

function startWatch(root) {
  const token = watchToken;
  const run = () => {
    beat(root, token).catch(() => {});
  };
  run();
  timers.push(setInterval(run, LOCAL_MS));
}

async function beat(root, token) {
  if (token !== watchToken) return;
  const list = await api('/api/conversations');
  if (token !== watchToken) return;
  const nextList = listKey(list.items);
  if (nextList !== listPainted) {
    listPainted = nextList;
    const listEl = document.querySelector('#conv-list');
    if (listEl) {
      listEl.innerHTML = drawList(list.items);
      bindList(root);
      applySearch();
    }
  }
  if (!selected) return;
  if (sends === 0 && !pulling && Date.now() - lastPull >= NEVOA_MS) {
    pulling = true;
    lastPull = Date.now();
    const id = selected;
    api(`/api/conversations/${encodeURIComponent(id)}/messages?refresh=1`)
      .then((data) => {
        if (token === watchToken && selected === id) showThread(id, data);
      })
      .catch(() => {})
      .finally(() => {
        pulling = false;
      });
  }
  const data = await api(`/api/conversations/${encodeURIComponent(selected)}/messages`);
  if (token === watchToken) showThread(selected, data);
}

function listKey(items) {
  return items.map((item) => `${item.id}:${item.preview}:${item.last_message_at}`).join('|');
}

function drawList(items) {
  if (!items.length) return '<p class="muted">Nenhuma conversa ainda.</p>';
  return items
    .map((item) => {
      const name = item.contact_name || item.contact_phone || 'Contato';
      return `
      <div class="conv-row">
        <button type="button" data-id="${escapeHtml(item.id)}" class="${item.id === selected ? 'active' : ''}">
          <span class="avatar" style="background:${avatarColor(name)}">${escapeHtml(initials(name))}</span>
          <span class="wa-copy">
            <span class="wa-line"><strong>${escapeHtml(name)}</strong><time>${escapeHtml(formatClock(item.last_message_at))}</time></span>
            <span class="wa-preview">${escapeHtml(item.preview || 'Sem mensagens')}</span>
          </span>
        </button>
        <button type="button" class="conv-remove" data-remove="${escapeHtml(item.id)}" aria-label="Apagar conversa">${trashIcon()}</button>
      </div>`;
    })
    .join('');
}

function applySearch() {
  const query = String(document.querySelector('#conv-search')?.value || '').trim().toLowerCase();
  document.querySelectorAll('#conv-list .conv-row').forEach((row) => {
    row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
  });
}

function syncThreadMode() {
  document.querySelector('.shell')?.classList.toggle('has-thread', Boolean(selected));
}

function emptyThread() {
  return `
    <div class="wa-empty">
      <svg class="mark" width="56" height="56" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="10" fill="#111827"/><path d="M9 22.5 16 8.5l7 14" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <h2>Vértice</h2>
      <p>Selecione uma conversa para ler e responder no WhatsApp.</p>
    </div>`;
}

function avatarColor(name) {
  const palette = ['#111827', '#1f2937', '#374151', '#047857', '#0f766e', '#1e3a5f'];
  let index = 0;
  for (const char of String(name)) index = (index + char.charCodeAt(0)) % palette.length;
  return palette[index];
}

function trashIcon() {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M8 7l1 13h6l1-13"/></svg>';
}

function bindList(root) {
  root.querySelectorAll('#conv-list button[data-id]').forEach((button) => {
    button.addEventListener('click', () => openConversation(button.dataset.id));
  });
  root.querySelectorAll('#conv-list button[data-remove]').forEach((button) => {
    button.addEventListener('click', () => removeConversation(button.dataset.remove));
  });
}

async function removeConversation(id) {
  if (!window.confirm('Apagar esta conversa da lista?')) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (selected === id) {
      selected = '';
      shownId = '';
      painted = '';
      const thread = document.querySelector('#thread');
      if (thread) thread.innerHTML = emptyThread();
      syncThreadMode();
    }
    document.querySelector(`#conv-list button[data-remove="${CSS.escape(id)}"]`)?.closest('.conv-row')?.remove();
  } catch (error) {
    toast(error.message);
  }
}

function markSelected(id) {
  document.querySelectorAll('#conv-list button[data-id]').forEach((button) => {
    button.classList.toggle('active', button.dataset.id === id);
  });
}

async function openContact(contactId) {
  const detail = await api(`/api/contacts/${encodeURIComponent(contactId)}`);
  if (detail.conversationId) {
    await openConversation(detail.conversationId);
    return;
  }
  const contact = detail.contact;
  selected = '';
  painted = '';
  document.querySelector('#thread').innerHTML = threadShell(contact.name, contact.phone, '<div class="bubbles"><p class="muted">Nenhuma mensagem ainda.</p></div>');
  bindBack();
  syncThreadMode();
  bindComposer(async (text) => {
    const sent = await api(`/api/contacts/${encodeURIComponent(contactId)}/send`, { method: 'POST', body: { text } });
    await openConversation(sent.conversationId);
  });
}

async function openConversation(id) {
  selected = id;
  painted = '';
  markSelected(id);
  syncThreadMode();
  const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages`);
  showThread(id, data);
  lastPull = 0;
}

function showThread(id, data) {
  if (selected !== id) return;
  if (data) snapshot = { items: data.items || [], conversation: data.conversation || snapshot.conversation };
  const items = mergePending(id, snapshot.items);
  const signature = items.map((item) => `${item.id}:${item.text}:${item.origin}:${item.pending ? 'p' : ''}:${item.failed ? 'f' : ''}`).join('|');
  const box = document.querySelector('.bubbles');
  const sameThread = shownId === id && box && document.querySelector('#send-form');
  if (sameThread && signature === painted) return;
  const html = bubbleHtml(items);
  if (sameThread) {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = html || '<p class="muted">Sem mensagens.</p>';
    if (stick) box.scrollTop = box.scrollHeight;
    painted = signature;
    return;
  }
  const conversation = (data && data.conversation) || snapshot.conversation || {};
  document.querySelector('#thread').innerHTML = threadShell(
    conversation.contact_name || 'Conversa',
    conversation.contact_phone || '',
    `<div class="bubbles">${html || '<p class="muted">Sem mensagens.</p>'}</div>`,
    Number(conversation.human_handoff) === 1,
  );
  const scroller = document.querySelector('.bubbles');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  bindComposer((text) => api(`/api/conversations/${encodeURIComponent(id)}/send`, { method: 'POST', body: { text } }));
  bindHandoff(id);
  bindBack();
  syncThreadMode();
  shownId = id;
  painted = signature;
}

function bubbleHtml(items) {
  return items
    .map((item, index) => {
      const outbound = item.direction === 'OUTBOUND';
      const previous = items[index - 1];
      const follow = previous && previous.direction === item.direction;
      const label = item.failed ? 'Não enviou' : item.pending ? 'Enviando' : ORIGIN[item.origin] || (outbound ? 'WhatsApp' : 'Contato');
      const body = item.text || (item.media_url ? item.media_url : `[${item.type}]`);
      const ticks = item.failed ? '!' : item.pending ? '✓' : '✓✓';
      return `
        <div class="bubble${outbound ? ' out' : ''}${follow ? ' follow' : ''}${item.pending ? ' pending' : ''}${item.failed ? ' failed' : ''}">
          ${outbound && !follow ? `<div class="who">${escapeHtml(label)}</div>` : ''}
          ${escapeHtml(body)}
          <div class="meta"><span>${escapeHtml(formatClock(item.created_at))}</span>${outbound ? `<span class="ticks">${ticks}</span>` : ''}</div>
        </div>`;
    })
    .join('');
}

function threadShell(name, phone, body, human) {
  const state = human ? 'Você responde. A IA está pausada nesta conversa.' : 'A IA responde esta conversa.';
  const title = name || 'Conversa';
  return `
    <header class="wa-head">
      <button class="icon-btn back" id="back-list" type="button" aria-label="Voltar às conversas">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <span class="avatar" style="background:${avatarColor(title)};color:#fff">${escapeHtml(initials(title))}</span>
      <div class="who-block">
        <strong>${escapeHtml(title)}</strong>
        <p class="muted">${escapeHtml(phone || '')}${phone ? ' · ' : ''}<span id="handoff-state">${state}</span></p>
      </div>
      <div class="mode" role="group" aria-label="Quem responde">
        <button type="button" data-mode="ia" aria-pressed="${human ? 'false' : 'true'}">IA</button>
        <button type="button" data-mode="humano" aria-pressed="${human ? 'true' : 'false'}">Humano</button>
      </div>
    </header>
    ${body}
    <form class="composer" id="send-form">
      <input name="text" placeholder="Mensagem" autocomplete="off" required />
      <button class="btn" type="submit" aria-label="Enviar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
    </form>`;
}

function bindBack() {
  document.querySelector('#back-list')?.addEventListener('click', () => {
    selected = '';
    shownId = '';
    painted = '';
    const thread = document.querySelector('#thread');
    if (thread) thread.innerHTML = emptyThread();
    markSelected('');
    syncThreadMode();
  });
}

function bindHandoff(conversationId) {
  const group = document.querySelector('.mode');
  if (!group) return;
  group.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button || button.getAttribute('aria-pressed') === 'true' || group.dataset.busy === '1') return;
    const human = button.dataset.mode === 'humano';
    const previous = !human;
    paintMode(group, human);
    group.dataset.busy = '1';
    try {
      await api(`/api/conversations/${encodeURIComponent(conversationId)}/handoff`, {
        method: 'PUT',
        body: { human },
      });
      if (snapshot.conversation) snapshot.conversation.human_handoff = human ? 1 : 0;
      const state = document.querySelector('#handoff-state');
      if (state) {
        state.textContent = human
          ? 'Você responde. A IA está pausada nesta conversa.'
          : 'A IA responde esta conversa.';
      }
    } catch (error) {
      paintMode(group, previous);
      toast(error.message);
    } finally {
      delete group.dataset.busy;
    }
  });
}

function paintMode(group, human) {
  for (const button of group.querySelectorAll('button[data-mode]')) {
    button.setAttribute('aria-pressed', String((button.dataset.mode === 'humano') === human));
  }
}

function mergePending(id, items) {
  const pool = items.filter((item) => item.direction === 'OUTBOUND').map((item) => item.text);
  const extras = [];
  for (const draft of pending) {
    if (draft.conversationId !== id) continue;
    if (!draft.failed) {
      const index = pool.indexOf(draft.text);
      if (index >= 0) {
        pool.splice(index, 1);
        continue;
      }
    }
    extras.push({
      id: draft.id,
      direction: 'OUTBOUND',
      origin: 'manual',
      text: draft.text,
      created_at: draft.createdAt,
      type: 'text',
      pending: !draft.failed,
      failed: draft.failed,
    });
  }
  return items.concat(extras);
}

function bindComposer(send) {
  const form = document.querySelector('#send-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = String(new FormData(form).get('text') || '').trim();
    if (!text) return;
    form.reset();
    const draft = {
      id: `pending-${Date.now()}`,
      conversationId: selected,
      text,
      createdAt: new Date().toISOString(),
      failed: false,
    };
    pending.push(draft);
    if (selected) showThread(selected);
    sends += 1;
    send(text)
      .catch((error) => {
        draft.failed = true;
        painted = '';
        if (selected) showThread(selected);
        const input = form.querySelector('input');
        if (input && !input.value) input.value = text;
        toast(error.message);
      })
      .finally(() => {
        sends -= 1;
      });
  });
}
