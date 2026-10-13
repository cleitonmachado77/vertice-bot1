import { api } from '../api.js';
import { escapeHtml, toast, displayName, viewLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

export async function renderContact(root, id, token = getNavToken()) {
  root.innerHTML = viewLoading('Carregando contato…');
  const [data, templates] = await Promise.all([
    api(`/api/contacts/${encodeURIComponent(id)}`),
    api('/api/templates'),
  ]);
  if (!isNavActive(token)) return;

  const contact = data.contact;
  const name = displayName(contact.name, contact.phone);
  const options = (templates.items || [])
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.language ? ` · ${escapeHtml(item.language)}` : ''}</option>`,
    )
    .join('');
  const pending = (templates.pending || []).map((item) => escapeHtml(item.name)).join(', ');
  root.innerHTML = `
    <div class="view-pane">
      <div class="top">
        <div>
          <p class="kicker">Contato</p>
          <h1>${escapeHtml(name || contact.phone)}</h1>
          <p class="muted">${escapeHtml(contact.phone)} ${contact.blocked ? '· bloqueado no WhatsApp' : ''}</p>
        </div>
        <div class="row">
          <a class="btn-ghost" href="#/inbox/c/${encodeURIComponent(id)}">Abrir inbox</a>
          <a class="btn-ghost" href="#/contacts">Voltar</a>
        </div>
      </div>
      <form class="split-board" id="contact-form">
        <section class="card stack" id="start-card">
          <h2>Iniciar conversa</h2>
          <p class="muted">Número novo recebe primeiro um template aprovado na Névoa. Depois a conversa segue no inbox.</p>
          ${
            options
              ? `<label>Template</label><select id="template">${options}</select><button class="btn" id="start" type="button">Enviar template</button>`
              : pending
                ? `<p class="muted">O template ${pending} está em revisão na Meta. O botão de iniciar a conversa aparece quando a Meta aprovar.</p>`
                : '<p class="muted">Nenhum template ativo neste WhatsApp. O primeiro contato só sai quando a Meta aprovar um modelo e ele aparecer na Névoa.</p>'
          }
        </section>
        <section class="card stack">
          <h2>Dados do contato</h2>
          <div class="grid-2">
            <div><label>Nome</label><input name="name" value="${escapeHtml(name)}" placeholder="Maria Souza" /></div>
            <div><label>Telefone</label><input name="phone" value="${escapeHtml(contact.phone || '')}" placeholder="+5543999999999" required /></div>
          </div>
          <label>E-mail</label>
          <input name="email" value="${escapeHtml(contact.email || '')}" placeholder="maria@email.com" />
          <label class="check"><input name="botEnabled" type="checkbox" ${contact.bot_enabled ? 'checked' : ''}/> Agente pode responder este contato</label>
          <button class="btn" type="submit">Salvar contato</button>
        </section>
      </form>
    </div>`;

  document.querySelector('#contact-form').addEventListener('submit', (event) => save(event, id, token));
  const start = document.querySelector('#start');
  if (start) {
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const result = await api(`/api/contacts/${encodeURIComponent(id)}/start`, {
          method: 'POST',
          body: { templateId: document.querySelector('#template').value },
        });
        toast('Conversa iniciada');
        location.hash = `#/inbox/${encodeURIComponent(result.conversationId)}`;
      } catch (error) {
        start.disabled = false;
        toast(error.message);
      }
    });
  }
}

async function save(event, id, token) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/contacts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        name: form.get('name'),
        phone: form.get('phone'),
        email: form.get('email'),
        botEnabled: form.get('botEnabled') === 'on',
      },
    });
    toast('Contato salvo');
    await renderContact(document.querySelector('#view'), id, token);
  } catch (error) {
    toast(error.message);
  }
}
