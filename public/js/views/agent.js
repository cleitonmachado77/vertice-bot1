import { api } from '../api.js';
import { escapeHtml, toast, panelLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

export async function renderAgent(root, token = getNavToken()) {
  if (!root.querySelector('#agent-form')) root.innerHTML = panelLoading('Carregando agente…');
  const agent = await api('/api/agent');
  if (!isNavActive(token)) return;
  const models = Array.isArray(agent.models) && agent.models.length ? agent.models : [agent.model].filter(Boolean);
  const modelOptions = models
    .map(
      (id) =>
        `<option value="${escapeHtml(id)}" ${id === agent.model ? 'selected' : ''}>${escapeHtml(id)}</option>`,
    )
    .join('');
  root.innerHTML = `
    <div class="split-board">
      <form class="card stack" id="agent-form">
        <div class="card-head">
          <h2>Modelo e prompt</h2>
          <p class="muted">Chave, modelo e o prompt geral do agente.</p>
        </div>
        <div class="grid-2">
          <div><label>Nome</label><input name="name" value="${escapeHtml(agent.name)}" /></div>
          <div>
            <label>Modelo</label>
            <select name="model" required>${modelOptions}</select>
            <p class="muted" id="models-hint">${
              agent.modelsError
                ? escapeHtml(agent.modelsError)
                : `${models.length} modelo(s) disponíveis na API`
            }</p>
          </div>
        </div>
        <label>Prompt geral</label>
        <textarea name="prompt">${escapeHtml(agent.prompt)}</textarea>
        <div class="grid-2">
          <div><label>URL do modelo</label><input name="baseUrl" value="${escapeHtml(agent.baseUrl)}" /></div>
          <div><label>Chave do modelo</label><input name="apiKey" type="password" placeholder="${agent.hasApiKey ? 'Chave salva' : 'Cole a chave'}" /></div>
        </div>
        <div class="grid-2">
          <div><label>Temperatura</label><input name="temperature" type="number" min="0" max="2" step="0.1" value="${agent.temperature}" /></div>
          <div><label>Mensagens de histórico</label><input name="history" type="number" min="1" max="30" value="${agent.history}" /></div>
        </div>
        <label>Mensagem reserva</label>
        <textarea name="fallback">${escapeHtml(agent.fallback)}</textarea>
        <p class="muted">No inbox, cada conversa fica em IA até você passar a chave para Humano.</p>
        <label class="check"><input name="active" type="checkbox" ${agent.active ? 'checked' : ''}/> Agente ativo</label>
        <div class="row form-actions">
          <button class="btn" type="submit">Salvar agente</button>
          <button class="btn-ghost" type="button" id="refresh-models">Atualizar modelos</button>
        </div>
      </form>
      <form class="card stack" id="preview-form">
        <div class="card-head">
          <h2>Testar prompt</h2>
          <p class="muted">Isso não envia nada no WhatsApp.</p>
        </div>
        <textarea name="text" placeholder="Olá, vocês atendem hoje?"></textarea>
        <button class="btn-ghost" type="submit">Gerar resposta</button>
        <pre id="preview-result">A resposta aparece aqui.</pre>
      </form>
    </div>`;

  root.querySelector('#refresh-models')?.addEventListener('click', async () => {
    toast('Atualizando lista de modelos…');
    await renderAgent(root, token);
  });

  root.querySelector('#agent-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/agent', {
        method: 'PUT',
        body: {
          name: form.get('name'),
          prompt: form.get('prompt'),
          model: form.get('model'),
          baseUrl: form.get('baseUrl'),
          apiKey: form.get('apiKey'),
          temperature: Number(form.get('temperature')),
          history: Number(form.get('history')),
          fallback: form.get('fallback'),
          active: form.get('active') === 'on',
          autoReply: form.get('active') === 'on',
        },
      });
      toast('Agente salvo');
      await renderAgent(root, token);
    } catch (error) {
      toast(error.message);
    }
  });

  root.querySelector('#preview-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('text');
    const target = root.querySelector('#preview-result');
    target.textContent = 'Gerando...';
    try {
      const result = await api('/api/agent/preview', { method: 'POST', body: { text } });
      target.textContent = result.text || result.detail || 'Sem resposta';
    } catch (error) {
      target.textContent = error.message;
    }
  });
}
