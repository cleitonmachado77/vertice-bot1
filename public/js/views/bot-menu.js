import { api } from '../api.js';
import { escapeHtml, panelLoading, toast } from '../ui.js';
import { isNavActive } from '../nav.js';

function contactSchedules(settings) {
  const contacts = Array.isArray(settings.contacts) ? settings.contacts : [];
  if (!contacts.length) {
    return `<div class="card-head">
      <h2>Horário de cada contato</h2>
      <p class="muted">Nenhum contato com formulário atribuído.</p>
    </div>`;
  }
  const rows = contacts
    .map((contact) => {
      const own = Boolean(contact.sendTime);
      const time = own ? contact.sendTime : settings.reminderTime || '08:00';
      const days = own ? contact.days : settings.reminderDays || 'daily';
      return `<tr data-contact-id="${escapeHtml(contact.id)}">
        <td>${escapeHtml(contact.name || 'Sem nome')}<br><span class="muted">${escapeHtml(contact.phone || '')}</span></td>
        <td><label class="check"><input data-use-default type="checkbox"${own ? '' : ' checked'}/> Padrão</label></td>
        <td><input data-time type="time" required value="${escapeHtml(time)}"${own ? '' : ' disabled'} /></td>
        <td>
          <select data-days${own ? '' : ' disabled'}>
            <option value="daily"${days === 'weekdays' ? '' : ' selected'}>Todos os dias</option>
            <option value="weekdays"${days === 'weekdays' ? ' selected' : ''}>Dias úteis</option>
          </select>
        </td>
      </tr>`;
    })
    .join('');
  return `<div class="card-head">
      <h2>Horário de cada contato</h2>
      <p class="muted">Desmarque “Padrão” para este contato receber o menu em outro horário. Marcado, ele segue o horário padrão.</p>
    </div>
    <div class="data-table-wrap">
    <table class="data-table">
      <thead><tr><th>Contato</th><th>Horário</th><th>Enviar às</th><th>Dias</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function previewText(settings) {
  const lines = [
    `Bom dia, Cleiton! ${settings.intro || 'O que deseja fazer hoje?'}`,
    '',
    '1) Separação — pendente hoje',
    '2) Separação de Bags — pendente hoje',
    '3) Produção de Fardos',
    '4) Entrega de Fardos — em andamento',
  ];
  if (settings.attendant) lines.push('5) Falar com um atendente');
  lines.push('', 'Responda com o número da opção. Digite *menu* a qualquer momento para voltar aqui.');
  return lines.join('\n');
}

export async function renderBotMenu(root, token) {
  root.innerHTML = panelLoading('Carregando menu…');
  const settings = await api('/api/bot-menu');
  if (!isNavActive(token)) return;

  root.innerHTML = `
    <form class="stack" id="bot-menu-form">
    <div class="split-board">
      <div class="card stack">
        <div class="card-head">
          <h2>Menu numerado no WhatsApp</h2>
          <p class="muted">Abre cada atendimento com os nomes dos padrões do Forms ligados ao contato. No horário de cada contato, o Bot envia só este menu — não os formulários — e o contato escolhe o que preencher. Se o contato chamar por conta própria, o menu aparece direto. Dentro do formulário, a coleta continua igual.</p>
        </div>
        <label class="check"><input name="enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}/> Menu ativo</label>
        <div class="grid-2">
          <div>
            <label>Horário padrão do lembrete</label>
            <input name="reminderTime" type="time" required value="${escapeHtml(settings.reminderTime || '08:00')}" />
          </div>
          <div>
            <label>Dias do lembrete</label>
            <select name="reminderDays">
              <option value="daily"${settings.reminderDays === 'weekdays' ? '' : ' selected'}>Todos os dias</option>
              <option value="weekdays"${settings.reminderDays === 'weekdays' ? ' selected' : ''}>Dias úteis</option>
            </select>
          </div>
        </div>
        <p class="muted">Vale para quem estiver no padrão. Os formulários ficam sempre disponíveis no menu; o lembrete só avisa no horário de cada contato.</p>
        <label>Pergunta de abertura</label>
        <input name="intro" maxlength="300" value="${escapeHtml(settings.intro)}" />
        <div class="grid-2">
          <div>
            <label>Novo atendimento após (horas sem mensagem)</label>
            <input name="sessionHours" type="number" min="0.25" max="48" step="0.25" value="${escapeHtml(settings.sessionHours)}" />
          </div>
          <div>
            <label>&nbsp;</label>
            <label class="check" style="margin-top:8px"><input name="attendant" type="checkbox" ${settings.attendant ? 'checked' : ''}/> Opção “Falar com um atendente”</label>
          </div>
        </div>
        <ul class="steps">
          <li>Se a primeira mensagem já for um registro (ex.: “fornecedor 2, 50 kg de abacate”), ela vai direto para a coleta.</li>
          <li>Durante um formulário, números são respostas do formulário; “menu” volta ao início.</li>
          <li>Contatos sem padrão do Forms continuam no agente normal.</li>
        </ul>
      </div>
      <section class="card stack">
        <div class="card-head">
          <h2>Prévia</h2>
          <p class="muted">Exemplo de abertura: cada opção é o nome do padrão, não o da tela.</p>
        </div>
        <pre id="bot-menu-preview">${escapeHtml(previewText(settings))}</pre>
      </section>
    </div>
    <section class="card stack">
      ${contactSchedules(settings)}
      <div class="row form-actions">
        <button class="btn" type="submit">Salvar menu</button>
      </div>
    </section>
    </form>`;

  const form = root.querySelector('#bot-menu-form');
  const preview = root.querySelector('#bot-menu-preview');
  const current = () => {
    const data = new FormData(form);
    return {
      enabled: data.get('enabled') === 'on',
      intro: String(data.get('intro') || ''),
      sessionHours: Number(data.get('sessionHours') || 2),
      attendant: data.get('attendant') === 'on',
      reminderTime: String(data.get('reminderTime') || '08:00'),
      reminderDays: String(data.get('reminderDays') || 'daily'),
      contactSchedules: [...form.querySelectorAll('[data-contact-id]')].map((row) => ({
        contactId: row.dataset.contactId,
        useDefault: row.querySelector('[data-use-default]').checked,
        reminderTime: row.querySelector('[data-time]').value,
        reminderDays: row.querySelector('[data-days]').value,
      })),
    };
  };
  form.querySelectorAll('[data-use-default]').forEach((box) => {
    box.addEventListener('change', () => {
      const row = box.closest('[data-contact-id]');
      const custom = !box.checked;
      const time = row.querySelector('[data-time]');
      const days = row.querySelector('[data-days]');
      time.disabled = !custom;
      days.disabled = !custom;
      if (!custom || !time.value) {
        time.value = form.querySelector('[name="reminderTime"]').value || '08:00';
        days.value = form.querySelector('[name="reminderDays"]').value || 'daily';
      }
    });
  });
  form.addEventListener('input', () => {
    const time = form.querySelector('[name="reminderTime"]').value;
    const days = form.querySelector('[name="reminderDays"]').value;
    form.querySelectorAll('[data-contact-id]').forEach((row) => {
      if (!row.querySelector('[data-use-default]').checked) return;
      row.querySelector('[data-time]').value = time || '08:00';
      row.querySelector('[data-days]').value = days || 'daily';
    });
    preview.textContent = previewText(current());
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/bot-menu', { method: 'PUT', body: current() });
      toast('Menu salvo');
    } catch (error) {
      toast(error.message, { tone: 'error' });
    }
  });
}
