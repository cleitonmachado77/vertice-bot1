import { api } from '../api.js';
import { escapeHtml, toast, panelLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

export async function renderIntegrations(root, token = getNavToken()) {
  if (!root.querySelector('#integration-form')) root.innerHTML = panelLoading('Carregando integrações…');
  const data = await api('/api/integrations');
  if (!isNavActive(token)) return;
  const origin = data.publicBaseUrl || location.origin;
  root.innerHTML = `
    <div class="stack">
      <section class="card stack">
        <div class="card-head row" style="justify-content: space-between;">
          <div>
            <h2>Webhook da Névoa</h2>
            <p class="muted">Cole esta URL na integração Public API, no campo Webhook URL.</p>
          </div>
          <button class="btn" id="test" type="button">Testar Névoa</button>
        </div>
        <input readonly value="${escapeHtml(origin + data.webhookPath)}" />
        <p id="test-result" class="muted"></p>
      </section>
      <form class="card stack" id="integration-form">
        <div class="card-head">
          <h2>Credenciais</h2>
          <p class="muted">A Névoa entrega as mensagens neste painel.</p>
        </div>
        <label>URL base da Névoa</label>
        <input name="nevoaBaseUrl" value="${escapeHtml(data.nevoaBaseUrl)}" />
        <div class="grid-2">
          <div><label>API Token</label><input name="nevoaToken" type="password" placeholder="${escapeHtml(data.nevoaToken || 'não configurado')}" /></div>
          <div><label>Webhook Secret</label><input name="webhookSecret" type="password" placeholder="${escapeHtml(data.webhookSecret || 'não configurado')}" /></div>
        </div>
        <label>Canal WhatsApp</label>
        <input name="channelId" value="${escapeHtml(data.channelId)}" />
        <label>URL pública deste painel</label>
        <input name="publicBaseUrl" value="${escapeHtml(data.publicBaseUrl)}" placeholder="${escapeHtml(location.origin)}" />
        <div class="row">
          <button class="btn" type="submit">Salvar</button>
          <button class="btn-ghost" id="copy-token" type="button">Copiar API Token</button>
        </div>
      </form>
    </div>`;

  root.querySelector('#test').addEventListener('click', async () => {
    const target = root.querySelector('#test-result');
    try {
      const result = await api('/api/integrations/test', { method: 'POST', body: {} });
      const channels = result.channels?.items || [];
      target.textContent = channels.length
        ? `Conectado: ${channels.map((item) => `${item.name} ${item.displayPhoneNumber}`).join(', ')}`
        : 'Conectado, sem canais no escopo.';
    } catch (error) {
      target.textContent = error.message;
    }
  });

  root.querySelector('#integration-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/integrations', { method: 'PUT', body: Object.fromEntries(form.entries()) });
      toast('Integração salva');
    } catch (error) {
      toast(error.message);
    }
  });
  root.querySelector('#copy-token').addEventListener('click', async () => {
    try {
      const secrets = await api('/api/integrations/secrets');
      await navigator.clipboard.writeText(secrets.nevoaToken || '');
      toast('Copiado');
    } catch (error) {
      toast(error.message);
    }
  });
}
