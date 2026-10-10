import { api } from '../api.js';
import { escapeHtml, formatWhen, toast } from '../ui.js';

export async function renderRoteiros(root) {
  const data = await api('/api/roteiros');
  root.innerHTML = `
    <div class="top">
      <div>
        <h1>Roteiros</h1>
        <p class="muted">O texto de como o agente conversa e a mensagem diária ficam aqui. O horário é o de Brasília.</p>
      </div>
      <button class="btn" id="run" type="button">Disparar os que já venceram</button>
    </div>
    <form class="card stack" id="new-roteiro" style="padding: 18px;">
      <h2>Novo roteiro</h2>
      ${fields()}
      <button class="btn" type="submit">Criar roteiro</button>
    </form>
    <div class="stack" style="margin-top: 14px;">${data.items.map(card).join('') || ''}</div>
    <section class="card" style="padding: 18px; margin-top: 14px;">
      <h2>Disparos de hoje</h2>
      <div class="list">${drawDispatches(data.dispatches)}</div>
    </section>`;
  document.querySelector('#new-roteiro').addEventListener('submit', (event) => save(event, ''));
  root.querySelectorAll('.roteiro-form').forEach((form) => {
    form.addEventListener('submit', (event) => save(event, form.dataset.id));
    form.querySelector('.remove').addEventListener('click', async () => {
      await api(`/api/roteiros/${form.dataset.id}`, { method: 'DELETE', body: {} });
      toast('Roteiro removido');
      await renderRoteiros(root);
    });
  });
  document.querySelector('#run').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api('/api/dispatches/run', { method: 'POST', body: {} });
      toast(`Enviados: ${result.sent}. Falhas: ${result.failed}. Aguardando horário: ${result.waiting}.`);
      await renderRoteiros(root);
    } catch (error) {
      event.currentTarget.disabled = false;
      toast(error.message);
    }
  });
}

function fields(item = {}) {
  return `
    <label>Nome</label>
    <input name="name" required value="${escapeHtml(item.name || '')}" />
    <label>Como o agente deve conversar</label>
    <textarea name="instructions" placeholder="Cumprimente, peça o nome e confirme o horário combinado.">${escapeHtml(item.instructions || '')}</textarea>
    <label>Mensagem diária</label>
    <textarea name="dailyMessage" placeholder="Bom dia. Como foi ontem? Pode responder por texto, áudio ou foto.">${escapeHtml(item.daily_message || '')}</textarea>
    <div class="grid-2">
      <div><label>Horário do disparo</label><input name="sendTime" value="${escapeHtml(item.send_time || '09:00')}" placeholder="09:00" /></div>
      <label class="check"><input name="active" type="checkbox" ${item.active === 0 ? '' : 'checked'}/> Roteiro ativo</label>
    </div>`;
}

function card(item) {
  return `
    <form class="card stack roteiro-form" data-id="${escapeHtml(item.id)}" style="padding: 18px;">
      ${fields(item)}
      <div class="row">
        <button class="btn" type="submit">Salvar</button>
        <button class="btn-danger remove" type="button">Excluir</button>
      </div>
    </form>`;
}

function drawDispatches(items) {
  if (!items.length) return '<p class="muted">Nenhum disparo hoje.</p>';
  return items
    .map(
      (item) => `
      <div class="person">
        <span><strong>${escapeHtml(item.contact_name || item.phone || 'Contato')}</strong><br>
        <span class="muted">${escapeHtml(item.roteiro_name || '')} · ${escapeHtml(item.response_type ? `resposta ${item.response_type}` : item.error || item.status)}</span></span>
        <span class="muted">${escapeHtml(formatWhen(item.response_at || item.sent_at))}</span>
      </div>`,
    )
    .join('');
}

async function save(event, id) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api(id ? `/api/roteiros/${id}` : '/api/roteiros', {
      method: id ? 'PUT' : 'POST',
      body: {
        name: form.get('name'),
        instructions: form.get('instructions'),
        dailyMessage: form.get('dailyMessage'),
        sendTime: form.get('sendTime'),
        active: form.get('active') === 'on',
      },
    });
    toast('Roteiro salvo');
    await renderRoteiros(document.querySelector('#view'));
  } catch (error) {
    toast(error.message);
  }
}
