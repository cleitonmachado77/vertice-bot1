import { api } from '../api.js';
import { escapeHtml, toast } from '../ui.js';

export async function renderIntegrations(root) {
  const data = await api('/api/integrations');
  const origin = data.publicBaseUrl || location.origin;
  root.innerHTML = `
    <div class="top">
      <div>
        <p class="kicker">Conexões</p>
        <h1>Integrações</h1>
        <p class="muted">A Névoa entrega as mensagens neste painel. O painel responde e faz os disparos do dia.</p>
      </div>
      <button class="btn" id="test" type="button">Testar Névoa</button>
    </div>
    <section class="card" style="padding: 18px; margin-bottom: 14px;">
      <h2>Webhook da Névoa</h2>
      <p class="muted">Cole esta URL na integração Public API, no campo Webhook URL.</p>
      <input readonly value="${escapeHtml(origin + data.webhookPath)}" />
      <p id="test-result" class="muted"></p>
    </section>
    <form class="card stack" id="integration-form" style="padding: 18px;">
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
    </form>`;

  document.querySelector('#test').addEventListener('click', async () => {
    const target = document.querySelector('#test-result');
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

  document.querySelector('#integration-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/integrations', { method: 'PUT', body: Object.fromEntries(form.entries()) });
      toast('Integração salva');
    } catch (error) {
      toast(error.message);
    }
  });
  document.querySelector('#copy-token').addEventListener('click', async () => {
    try {
      const secrets = await api('/api/integrations/secrets');
      await navigator.clipboard.writeText(secrets.nevoaToken || '');
      toast('Copiado');
    } catch (error) {
      toast(error.message);
    }
  });
}
