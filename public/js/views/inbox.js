import { api } from '../api.js';
import { escapeHtml, formatClock, initials, toast, createPoll } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

const ORIGIN = {
  contact: 'Contato',
  manual: 'Manual',
  agent: 'Agente',
  scheduled: 'Programada',
  whatsapp: 'WhatsApp',
};

const LOCAL_MS = 8000;
const NEVOA_MS = 10000;

let selected = '';
let watchToken = 0;
let stopPoll = null;
let pulling = false;
let lastPull = 0;
let painted = '';
let listPainted = '';
let shownId = '';
let snapshot = { items: [], conversation: null, session: null, templates: [], defaultTemplateId: '' };
let pending = [];
let sends = 0;
let paintedGate = '';
let navToken = 0;

export function stopInbox() {
  watchToken += 1;
  if (stopPoll) stopPoll();
  stopPoll = null;
  pulling = false;
}

export function updateInboxHandoffBadge(count) {
  const badge = document.querySelector('#inbox-handoff-badge');
  if (!badge) return;
  const n = Number(count) || 0;
  if (n > 0) {
    badge.hidden = false;
    badge.textContent = n > 99 ? '99+' : String(n);
  } else {
    badge.hidden = true;
    badge.textContent = '';
  }
}

export async function renderInbox(root, focus = '', token = getNavToken()) {
  stopInbox();
  navToken = token;
  root.innerHTML = `
    <section class="split">
      <aside class="wa-list">
        <div class="wa-list-head">
          <h2>Conversas</h2>
          <input id="conv-search" type="search" placeholder="Pesquisar conversa" />
        </div>
        <div id="handoff-banner" class="handoff-banner" hidden></div>
        <div class="wa-scroll" id="conv-list"><p class="muted">Carregando conversas…</p></div>
      </aside>
      <div class="thread" id="thread">${emptyThread()}</div>
    </section>`;
  document.querySelector('#conv-search').addEventListener('input', applySearch);
  syncThreadMode();

  const data = await api('/api/conversations');
  if (!isNavActive(token) || token !== navToken) return;

  paintConversationList(root, data.items || []);
  if (focus.startsWith('c/')) await openContact(focus.slice(2), token);
  else if (focus) await openConversation(focus, token);
  else if (selected) await openConversation(selected, token);
  if (!isNavActive(token) || token !== navToken) return;
  startWatch(root, token);
}

function startWatch(root, token) {
  const localToken = watchToken;
  const run = () => beat(root, localToken, token);
  run();
  stopPoll = createPoll(run, LOCAL_MS);
}

async function beat(root, localToken, token) {
  if (localToken !== watchToken || !isNavActive(token)) return;
  const list = await api('/api/conversations');
  if (localToken !== watchToken || !isNavActive(token)) return;
  const nextList = listKey(list.items);
  if (nextList !== listPainted) {
    paintConversationList(root, list.items || []);
  }
  if (!selected) return;
  if (sends === 0 && !pulling && Date.now() - lastPull >= NEVOA_MS) {
    pulling = true;
    lastPull = Date.now();
    const id = selected;
    // Fire-and-forget refresh so Nevoa sync never blocks navigation.
    api(`/api/conversations/${encodeURIComponent(id)}/messages?refresh=1`)
      .then((data) => {
        if (localToken === watchToken && isNavActive(token) && selected === id) showThread(id, data);
      })
      .catch(() => {})
      .finally(() => {
        pulling = false;
      });
  }
  const data = await api(`/api/conversations/${encodeURIComponent(selected)}/messages`);
  if (localToken === watchToken && isNavActive(token)) showThread(selected, data);
}

function listKey(items) {
  return (items || [])
    .map(
      (item) =>
        `${item.id}:${item.preview}:${item.last_message_at}:${Number(item.human_handoff) || 0}:${Number(item.awaiting_human) || 0}`,
    )
    .join('|');
}

function isAwaitingHuman(item) {
  return Number(item?.awaiting_human) === 1;
}

function handoffCount(items) {
  return (items || []).filter((item) => isAwaitingHuman(item)).length;
}

function sortedConversations(items) {
  return [...(items || [])].sort((a, b) => {
    const ha = isAwaitingHuman(a) ? 1 : 0;
    const hb = isAwaitingHuman(b) ? 1 : 0;
    if (ha !== hb) return hb - ha;
    return String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''));
  });
}

function paintConversationList(root, items) {
  const ordered = sortedConversations(items);
  listPainted = listKey(items);
  const waiting = handoffCount(ordered);
  updateInboxHandoffBadge(waiting);
  const banner = document.querySelector('#handoff-banner');
  if (banner) {
    if (waiting > 0) {
      banner.hidden = false;
      banner.innerHTML = `<strong>${waiting}</strong> conversa${waiting > 1 ? 's' : ''} aguardando atendimento humano`;
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
    }
  }
  const listEl = document.querySelector('#conv-list');
  if (listEl) {
    listEl.innerHTML = drawList(ordered);
    bindList(root);
    applySearch();
  }
}

function drawList(items) {
  if (!items.length) return '<p class="muted">Nenhuma conversa ainda.</p>';
  return items
    .map((item) => {
      const name = item.contact_name || item.contact_phone || 'Contato';
      const needsHuman = isAwaitingHuman(item);
      return `
      <div class="conv-row${needsHuman ? ' needs-human' : ''}">
        <button type="button" data-id="${escapeHtml(item.id)}" class="${item.id === selected ? 'active' : ''}">
          <span class="avatar" style="background:${avatarColor(name)}">${escapeHtml(initials(name))}</span>
          <span class="wa-copy">
            <span class="wa-line">
              <strong>${escapeHtml(name)}</strong>
              <time>${escapeHtml(formatClock(item.last_message_at))}</time>
            </span>
            <span class="wa-preview">${
              needsHuman
                ? '<span class="handoff-tag">Aguardando humano</span> '
                : ''
            }${escapeHtml(item.preview || 'Sem mensagens')}</span>
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
      <img class="brand-logo" src="/logo-vertice.png" alt="Vértice Bot" />
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

async function openContact(contactId, token = navToken) {
  const detail = await api(`/api/contacts/${encodeURIComponent(contactId)}`);
  if (!isNavActive(token)) return;
  if (detail.conversationId) {
    await openConversation(detail.conversationId, token);
    return;
  }
  toast('Não foi possível abrir a conversa deste contato');
}

async function openConversation(id, token = navToken) {
  selected = id;
  painted = '';
  paintedGate = '';
  markSelected(id);
  syncThreadMode();
  const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages`);
  if (!isNavActive(token)) return;
  showThread(id, data);
  lastPull = 0;
}

function showThread(id, data) {
  if (selected !== id) return;
  if (data) {
    snapshot = {
      items: data.items || [],
      conversation: data.conversation || snapshot.conversation,
      session: data.session || null,
      templates: data.templates || [],
      defaultTemplateId: data.defaultTemplateId || '',
    };
  }
  const items = mergePending(id, snapshot.items);
  const session = snapshot.session || {};
  const gateSig = `${session.requiresTemplate ? 1 : 0}:${session.firstContact ? 1 : 0}:${snapshot.defaultTemplateId}:${(snapshot.templates || []).length}`;
  const signature = items
    .map(
      (item) =>
        `${item.id}:${item.text}:${item.origin}:${item.delivery_status || ''}:${item.pending ? 'p' : ''}:${item.failed ? 'f' : ''}`,
    )
    .join('|');
  const box = document.querySelector('.bubbles');
  const sameThread = shownId === id && box && (document.querySelector('#send-form') || document.querySelector('#template-form'));
  if (sameThread && signature === painted && gateSig === paintedGate) return;
  const html = bubbleHtml(items);
  if (sameThread && gateSig === paintedGate) {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = html || '<p class="muted">Sem mensagens.</p>';
    if (stick) box.scrollTop = box.scrollHeight;
    painted = signature;
    return;
  }
  const conversation = snapshot.conversation || {};
  document.querySelector('#thread').innerHTML = threadShell(
    conversation.contact_name || 'Conversa',
    conversation.contact_phone || '',
    `<div class="bubbles">${html || '<p class="muted">Sem mensagens.</p>'}</div>`,
    Number(conversation.human_handoff) === 1,
    session,
    snapshot.templates || [],
    snapshot.defaultTemplateId || '',
  );
  const scroller = document.querySelector('.bubbles');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  if (session.requiresTemplate) bindTemplateComposer(id);
  else bindComposer((text) => api(`/api/conversations/${encodeURIComponent(id)}/send`, { method: 'POST', body: { text } }));
  bindHandoff(id);
  bindBack();
  syncThreadMode();
  shownId = id;
  painted = signature;
  paintedGate = gateSig;
}

function bubbleHtml(items) {
  return items
    .map((item, index) => {
      const outbound = item.direction === 'OUTBOUND';
      const previous = items[index - 1];
      const follow = previous && previous.direction === item.direction;
      const refused = item.delivery_status === 'failed';
      const failed = item.failed || refused;
      const label = failed ? 'Não enviou' : item.pending ? 'Enviando' : ORIGIN[item.origin] || (outbound ? 'WhatsApp' : 'Contato');
      const body = item.text || (item.media_url ? item.media_url : `[${item.type}]`);
      const ticks = failed ? '!' : item.pending ? '✓' : '✓✓';
      const reason = refused ? deliveryReason(item.delivery_code) : '';
      return `
        <div class="bubble${outbound ? ' out' : ''}${follow ? ' follow' : ''}${item.pending ? ' pending' : ''}${failed ? ' failed' : ''}">
          ${outbound && !follow ? `<div class="who">${escapeHtml(label)}</div>` : ''}
          ${escapeHtml(body)}
          <div class="meta"><span>${escapeHtml(formatClock(item.created_at))}</span>${outbound ? `<span class="ticks">${ticks}</span>` : ''}</div>
          ${reason ? `<div class="meta">${escapeHtml(reason)}</div>` : ''}
        </div>`;
    })
    .join('');
}

function deliveryReason(code) {
  if (String(code) === '131042') return 'A Meta recusou: a conta do WhatsApp ainda não tem moeda de cobrança.';
  if (String(code) === '131049') return 'A Meta segurou esta mensagem de marketing para limitar o volume neste número.';
  return 'A Meta recusou este envio.';
}

function threadShell(name, phone, body, human, session = {}, templates = [], defaultTemplateId = '') {
  const state = human ? 'Você responde. A IA está pausada nesta conversa.' : 'A IA responde esta conversa.';
  const title = name || 'Conversa';
  const locked = Boolean(session.requiresTemplate);
  const options = templates
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}" ${item.id === defaultTemplateId ? 'selected' : ''}>${escapeHtml(
          item.name,
        )}</option>`,
    )
    .join('');
  const selectedBody = templates.find((item) => item.id === defaultTemplateId)?.body || templates[0]?.body || '';
  const composer = locked
    ? `<div class="template-gate">
        <strong>${session.firstContact ? 'Primeiro contato' : 'Janela fechada'}</strong>
        <p>${escapeHtml(
          session.message ||
            'A primeira mensagem precisa ser um template Meta. Mensagens livres ficam bloqueadas até o envio.',
        )}</p>
        ${
          options
            ? `<form class="template-composer" id="template-form">
                <label>Template Meta</label>
                <select name="templateId" id="template-select">${options}</select>
                <p class="muted template-preview" id="template-preview">${escapeHtml(selectedBody)}</p>
                <button class="btn" type="submit">Enviar template</button>
              </form>`
            : '<p class="muted">Nenhum template aprovado na Névoa. Cadastre e aprove um modelo de primeiro contato.</p>'
        }
        <form class="composer is-locked" id="send-form" aria-disabled="true">
          <input name="text" placeholder="Mensagem livre bloqueada até enviar o template" disabled />
          <button class="btn" type="submit" disabled aria-label="Enviar bloqueado">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </form>
      </div>`
    : `<form class="composer" id="send-form">
        <input name="text" placeholder="Mensagem" autocomplete="off" required />
        <button class="btn" type="submit" aria-label="Enviar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </button>
      </form>`;
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
    ${composer}`;
}

function bindBack() {
  document.querySelector('#back-list')?.addEventListener('click', () => {
    selected = '';
    shownId = '';
    painted = '';
    paintedGate = '';
    const thread = document.querySelector('#thread');
    if (thread) thread.innerHTML = emptyThread();
    markSelected('');
    syncThreadMode();
  });
}

function bindTemplateComposer(conversationId) {
  const select = document.querySelector('#template-select');
  const preview = document.querySelector('#template-preview');
  select?.addEventListener('change', () => {
    const row = (snapshot.templates || []).find((item) => item.id === select.value);
    if (preview) preview.textContent = row?.body || '';
  });
  const form = document.querySelector('#template-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    const templateId = String(new FormData(form).get('templateId') || '');
    if (!templateId) return;
    if (button) button.disabled = true;
    try {
      await api(`/api/conversations/${encodeURIComponent(conversationId)}/template`, {
        method: 'POST',
        body: { templateId },
      });
      toast('Template enviado');
      painted = '';
      paintedGate = '';
      await openConversation(conversationId);
    } catch (error) {
      toast(error.message);
    } finally {
      if (button) button.disabled = false;
    }
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
      if (snapshot.conversation) {
        snapshot.conversation.human_handoff = human ? 1 : 0;
        // Toggle manual não gera alerta — só a IA pedindo humano.
        snapshot.conversation.awaiting_human = 0;
      }
      const state = document.querySelector('#handoff-state');
      if (state) {
        state.textContent = human
          ? 'Você responde. A IA está pausada nesta conversa.'
          : 'A IA responde esta conversa.';
      }
      clearAwaitingHumanUi(conversationId);
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

function clearAwaitingHumanUi(conversationId) {
  if (snapshot.conversation?.id === conversationId || selected === conversationId) {
    if (snapshot.conversation) snapshot.conversation.awaiting_human = 0;
  }
  const row = document
    .querySelector(`#conv-list button[data-id="${CSS.escape(conversationId)}"]`)
    ?.closest('.conv-row');
  if (row) {
    row.classList.remove('needs-human');
    const preview = row.querySelector('.wa-preview');
    if (preview) {
      const text = preview.textContent.replace(/^Aguardando humano\s*/, '');
      preview.textContent = text;
    }
  }
  const waiting = document.querySelectorAll('#conv-list .conv-row.needs-human').length;
  updateInboxHandoffBadge(waiting);
  const banner = document.querySelector('#handoff-banner');
  if (banner) {
    if (waiting > 0) {
      banner.hidden = false;
      banner.innerHTML = `<strong>${waiting}</strong> conversa${waiting > 1 ? 's' : ''} aguardando atendimento humano`;
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
    }
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
      .then(() => {
        if (draft.conversationId) clearAwaitingHumanUi(draft.conversationId);
      })
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
