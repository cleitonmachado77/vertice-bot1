import { api } from '../api.js';
import { escapeHtml, panelLoading, toast } from '../ui.js';
import { isNavActive } from '../nav.js';

function previewText(settings) {
  const lines = [
    `Bom dia, Cleiton! ${settings.intro || 'O que deseja fazer hoje?'}`,
    '',
    '1) Compras — pendente hoje',
    '2) Inventário — pendente hoje',
    '3) Fabricação',
    '4) Vendas — em andamento',
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
    <div class="split-board">
      <form class="card stack" id="bot-menu-form">
        <div class="card-head">
          <h2>Menu numerado no WhatsApp</h2>
          <p class="muted">Abre cada atendimento com opções numeradas (Compras, Inventário, Fabricação, Vendas) montadas a partir dos padrões do Forms ligados ao contato. No horário padrão, o Bot envia só este menu — não os formulários — e o contato escolhe o que preencher. Se o contato chamar por conta própria, o menu aparece direto. Dentro do formulário, a coleta continua igual.</p>
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
        <p class="muted">Vale para todos os formulários com Bot ativo. Os formulários ficam sempre disponíveis no menu; o lembrete só avisa o contato do que está pendente.</p>
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
        <div class="row form-actions">
          <button class="btn" type="submit">Salvar menu</button>
        </div>
      </form>
      <section class="card stack">
        <div class="card-head">
          <h2>Prévia</h2>
          <p class="muted">Exemplo de abertura para um contato com padrões de Compras, Inventário, Fabricação e Vendas.</p>
        </div>
        <pre id="bot-menu-preview">${escapeHtml(previewText(settings))}</pre>
      </section>
    </div>`;

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
    };
  };
  form.addEventListener('input', () => {
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
