import { api } from '../api.js';
import { escapeHtml, formatWhen, toast } from '../ui.js';

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
    <div class="top">
      <div>
        <p class="kicker">Conversas</p>
        <h1>Inbox</h1>
        <p class="muted">A conversa aberta acompanha a Névoa sozinha. Sem assumir, a IA responde.</p>
      </div>
    </div>
    <section class="split">
      <div class="card list" id="conv-list" style="padding: 8px 14px;">${drawList(data.items)}</div>
      <div class="card thread" id="thread" style="padding: 16px;"><p class="muted">Escolha uma conversa.</p></div>
    </section>`;
  listPainted = listKey(data.items);
  bindList(root);
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
    .map(
      (item) => `
      <div class="conv-row">
        <button type="button" data-id="${escapeHtml(item.id)}" class="${item.id === selected ? 'active' : ''}">
          <span><strong>${escapeHtml(item.contact_name || item.contact_phone || 'Contato')}</strong><br>
          <span class="muted">${escapeHtml(item.preview || 'Sem mensagens')}</span></span>
          <span class="muted">${escapeHtml(formatWhen(item.last_message_at))}</span>
        </button>
        <button type="button" class="conv-remove" data-remove="${escapeHtml(item.id)}" aria-label="Apagar conversa">Apagar</button>
      </div>`,
    )
    .join('');
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
      if (thread) thread.innerHTML = '<p class="muted">Escolha uma conversa.</p>';
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
  document.querySelector('#thread').innerHTML = threadShell(contact.name, contact.phone, '<p class="muted">Nenhuma mensagem ainda.</p>');
  bindComposer(async (text) => {
    const sent = await api(`/api/contacts/${encodeURIComponent(contactId)}/send`, { method: 'POST', body: { text } });
    await openConversation(sent.conversationId);
  });
}

async function openConversation(id) {
  selected = id;
  painted = '';
  markSelected(id);
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
  shownId = id;
  painted = signature;
}

function bubbleHtml(items) {
  return items
    .map((item) => {
      const label = item.failed ? 'Não enviou' : item.pending ? 'Enviando' : ORIGIN[item.origin] || (item.direction === 'OUTBOUND' ? 'WhatsApp' : 'Contato');
      const body = item.text || (item.media_url ? item.media_url : `[${item.type}]`);
      return `
        <div class="bubble ${item.direction === 'OUTBOUND' ? 'out' : ''}">
          <div class="who">${escapeHtml(label)}</div>
          ${escapeHtml(body)}
          <div class="muted">${escapeHtml(formatWhen(item.created_at))}</div>
        </div>`;
    })
    .join('');
}

function threadShell(name, phone, body, human) {
  const state = human
    ? 'Você responde. A IA está pausada nesta conversa.'
    : 'A IA responde esta conversa.';
  return `
    <div class="row" style="justify-content: space-between; align-items: center;">
      <div>
        <strong>${escapeHtml(name || 'Conversa')}</strong>
        <p class="muted">${escapeHtml(phone || '')}</p>
      </div>
      <label class="check"><input id="handoff" type="checkbox" ${human ? 'checked' : ''}/> Assumir conversa</label>
    </div>
    <p class="muted" id="handoff-state">${state}</p>
    ${body}
    <form class="composer" id="send-form">
      <input name="text" placeholder="Escrever no WhatsApp" required />
      <button class="btn" type="submit">Enviar</button>
    </form>`;
}

function bindHandoff(conversationId) {
  const input = document.querySelector('#handoff');
  if (!input) return;
  input.addEventListener('change', async () => {
    const human = input.checked;
    const state = document.querySelector('#handoff-state');
    try {
      await api(`/api/conversations/${encodeURIComponent(conversationId)}/handoff`, {
        method: 'PUT',
        body: { human },
      });
      if (state) {
        state.textContent = human
          ? 'Você responde. A IA está pausada nesta conversa.'
          : 'A IA responde esta conversa.';
      }
    } catch (error) {
      input.checked = !human;
      toast(error.message);
    }
  });
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
