import { api } from '../api.js';
import { escapeHtml, toast, viewLoading } from '../ui.js';
import { bindUsersSection, renderUsersSection } from './web-settings-users.js';

const ADM_TABS = [
  { id: 'usuarios', label: 'Usuários' },
  { id: 'sincronizacao', label: 'Sincronização' },
  { id: 'odoo', label: 'Odoo' },
];

const USER_TABS = [{ id: 'conta', label: 'Conta' }];

function resolveTab(tab, isAdm) {
  const tabs = isAdm ? ADM_TABS : USER_TABS;
  const raw = tab === 'conta' && isAdm ? 'usuarios' : tab;
  return tabs.some((item) => item.id === raw) ? raw : tabs[0].id;
}

export async function renderWebSettings(root, me = null, tab = 'usuarios') {
  root.innerHTML = viewLoading('Carregando configurações…');
  const isAdm = Boolean(me?.isAdm || me?.user?.role === 'adm');
  const user = me?.user || null;
  const active = resolveTab(tab, isAdm);
  const tabs = isAdm ? ADM_TABS : USER_TABS;
  const desiredHash = `#/web/settings/${active}`;

  if (location.hash !== desiredHash) {
    location.replace(desiredHash);
    return;
  }

  const needsUsers = isAdm && active === 'usuarios';
  const needsOdoo = isAdm && (active === 'sincronizacao' || active === 'odoo');

  const [data, status, usersPack] = await Promise.all([
    needsOdoo || active === 'odoo' ? api('/api/forms/odoo/settings') : Promise.resolve({}),
    needsOdoo && active === 'sincronizacao'
      ? api('/api/forms/odoo/status').catch(() => ({}))
      : Promise.resolve({}),
    needsUsers ? api('/api/users').catch(() => ({ items: [], companies: [] })) : Promise.resolve(null),
  ]);

  const lastPull = status.lastPullAt
    ? new Date(status.lastPullAt).toLocaleString('pt-BR')
    : 'ainda não';
  const pull = status.lastPull || {};
  const warehouseWarn = Array.isArray(status.companiesWithoutWarehouse)
    ? status.companiesWithoutWarehouse
    : [];
  const canEditOdoo = data.canEditOdoo !== false && isAdm;

  root.innerHTML = `
    <div class="hub-view web-settings-view">
      <header class="hub-hero web-settings-hero">
        <h1>Configurações</h1>
      </header>

      <nav class="settings-tabs web-settings-tabs" aria-label="Seções de configuração">
        ${tabs
          .map(
            (item) =>
              `<a class="settings-tab${item.id === active ? ' active' : ''}" href="#/web/settings/${item.id}">${item.label}</a>`,
          )
          .join('')}
      </nav>

      <div class="web-settings-panel" id="web-settings-panel">
        ${renderPanel({ active, isAdm, user, usersPack, data, lastPull, pull, warehouseWarn, canEditOdoo })}
      </div>
    </div>`;

  const reload = async () => {
    const next = await api('/api/me');
    await renderWebSettings(root, next, active);
  };

  if (active === 'usuarios' && isAdm) bindUsersSection(root, reload, usersPack);
  if (active === 'sincronizacao' && canEditOdoo) bindSyncSection();
  if (active === 'odoo' && canEditOdoo) bindOdooForm();
}

function renderPanel({ active, isAdm, user, usersPack, data, lastPull, pull, warehouseWarn, canEditOdoo }) {
  if (active === 'usuarios' && isAdm) {
    return `${renderAccountCard(user, true)}${renderUsersSection(usersPack)}`;
  }
  if (active === 'sincronizacao' && canEditOdoo) {
    return renderSyncSection(lastPull, pull, warehouseWarn || []);
  }
  if (active === 'odoo' && canEditOdoo) return renderOdooSection(data);
  return renderAccountCard(user, false);
}

function renderAccountCard(user, compact) {
  return `
    <section class="card stack web-odoo-card${compact ? ' web-settings-account-card' : ''}">
      <div class="card-head">
        <h2>Sua conta</h2>
        <p class="muted">Sessão ativa neste navegador.</p>
      </div>
      <p class="session-summary">
        <strong>${escapeHtml(user?.name || '—')}</strong>
        · ${escapeHtml(user?.email || '—')}
        · <span class="role-pill role-pill--${escapeHtml(user?.role || 'user')}">${
          user?.role === 'adm' ? 'ADM' : 'Gestor Entidade'
        }</span>
        ${
          user?.role === 'user' && user?.companyOdooId
            ? `· empresa #${escapeHtml(user.companyOdooId)}`
            : ''
        }
      </p>
      ${
        compact
          ? ''
          : `<p class="muted" style="margin:12px 0 0;">Você vê apenas dados e configurações da empresa vinculada à sua conta. Integração Odoo e gestão de usuários ficam com o ADM.</p>
      <div class="row" style="margin-top:14px;">
        <a class="btn-ghost" href="#/web">Voltar aos apps</a>
      </div>`
      }
    </section>`;
}

function renderSyncSection(lastPull, pull, warehouseWarn = []) {
  const warnHtml =
    warehouseWarn.length > 0
      ? `<p class="forms-sync-notice is-error" role="status">
          Empresas sem depósito de recebimento no Odoo:
          ${escapeHtml(warehouseWarn.map((c) => c.name || `#${c.id}`).join('; '))}.
          Use “Sincronizar empresas” para criar o warehouse padrão automaticamente.
        </p>`
      : '';
  return `
    <section class="card stack web-odoo-card">
      <div class="card-head">
        <h2>Sincronização</h2>
        <p class="muted">Recebe e envia o projeto todo (empresa ativa no seletor do topo). Pull automático a cada 5 min em segundo plano.</p>
      </div>
      <p id="odoo-sync-status" class="muted">
        Último recebimento: ${escapeHtml(lastPull)}
        · ${pull.products || 0} produtos
        · ${pull.partners || 0} parceiros
        · ${pull.sales || 0} vendas
        · ${pull.purchases || 0} compras
      </p>
      ${warnHtml}
      <pre id="odoo-sync-log" class="odoo-sync-log" hidden aria-live="polite"></pre>
      <div class="row">
        <button class="btn" id="odoo-pull" type="button">Receber dados</button>
        <button class="btn-ghost" id="odoo-push" type="button">Enviar dados</button>
        <button class="btn-ghost" id="sync-companies" type="button">Sincronizar empresas</button>
      </div>
    </section>`;
}

function renderOdooSection(data) {
  return `
    <form class="card stack web-odoo-card" id="odoo-form">
      <div class="card-head row" style="justify-content: space-between; align-items:flex-start;">
        <div>
          <h2>Odoo</h2>
          <p class="muted">Uma API Key. A empresa ativa é escolhida no seletor do topo (como no Odoo).</p>
        </div>
        <button class="btn" id="test-odoo" type="button">Testar Odoo</button>
      </div>
      <label>URL do Odoo</label>
      <input name="odooUrl" value="${escapeHtml(data.odooUrl || '')}" placeholder="https://www.reciclarenda.com.br" />
      <div class="grid-2">
        <div>
          <label>Banco de dados</label>
          <input name="odooDb" value="${escapeHtml(data.odooDb || '')}" placeholder="nome do banco" />
        </div>
        <div>
          <label>Login</label>
          <input name="odooLogin" value="${escapeHtml(data.odooLogin || '')}" placeholder="usuario@empresa.com" />
        </div>
      </div>
      <label>API Key</label>
      <input name="odooApiKey" type="password" placeholder="${escapeHtml(data.odooApiKey || 'não configurado')}" />
      <p id="odoo-test-result" class="muted">${data.odooConfigured ? 'Credenciais salvas.' : 'Preencha banco, login e API Key.'}</p>
      <div class="row">
        <button class="btn" type="submit">Salvar</button>
        <a class="btn-ghost" href="#/web">Voltar aos apps</a>
      </div>
    </form>`;
}

function bindSyncSection() {
  const syncStatus = () => document.querySelector('#odoo-sync-status');
  const syncLog = () => document.querySelector('#odoo-sync-log');

  function paintPullLog(progress) {
    const logEl = syncLog();
    const statusEl = syncStatus();
    if (!logEl) return;
    const lines = progress?.lines || [];
    if (!lines.length && !progress?.running) {
      logEl.hidden = true;
      logEl.textContent = '';
      return;
    }
    logEl.hidden = false;
    logEl.textContent = lines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
    if (statusEl && progress?.running) {
      statusEl.textContent = `Recebendo · ${progress.step || '…'} · ${progress.elapsedSec || 0}s`;
    }
  }

  function startPullProgressPolling() {
    const timer = window.setInterval(async () => {
      try {
        const progress = await api('/api/forms/odoo/pull/progress');
        paintPullLog(progress);
        if (!progress.running) window.clearInterval(timer);
      } catch {
        /* ignore transient poll errors */
      }
    }, 800);
    return timer;
  }

  document.querySelector('#sync-companies')?.addEventListener('click', async () => {
    const target = syncStatus();
    target.textContent = 'Sincronizando empresas…';
    try {
      const result = await api('/api/forms/companies/sync', { method: 'POST', body: {} });
      target.textContent = `${result.items?.length || 0} empresa(s) · ativa: ${result.active?.name || result.activeId || '—'}`;
      toast('Empresas sincronizadas');
      window.dispatchEvent(new CustomEvent('vertice:company-changed', { detail: { activeId: result.activeId } }));
    } catch (error) {
      target.textContent = error.message;
      toast(error.message);
    }
  });

  document.querySelector('#odoo-pull')?.addEventListener('click', async () => {
    if (
      !confirm(
        'Receber todos os dados do Odoo (empresas, produtos, estoque, parceiros, compras e vendas)?',
      )
    ) {
      return;
    }
    const target = syncStatus();
    const pullBtn = document.querySelector('#odoo-pull');
    const pushBtn = document.querySelector('#odoo-push');
    const started = Date.now();
    if (pullBtn) pullBtn.disabled = true;
    if (pushBtn) pushBtn.disabled = true;
    if (target) target.textContent = 'Recebendo · iniciando · 0s';
    paintPullLog({ running: true, step: 'iniciando', elapsedSec: 0, lines: ['iniciando (+0s)'] });
    const progressTimer = startPullProgressPolling();
    try {
      const result = await api('/api/forms/odoo/pull', {
        method: 'POST',
        body: { auto: false },
        timeoutMs: 5 * 60 * 1000,
      });
      const sec = Math.round((Date.now() - started) / 1000);
      const progress = await api('/api/forms/odoo/pull/progress').catch(() => null);
      if (progress) paintPullLog(progress);
      if (result.skipped) {
        if (target) {
          target.textContent = `Já recebido recentemente (throttle) · ${result.products || 0} produtos · ${result.sales || 0} vendas · ${result.purchases || 0} compras`;
        }
        toast('Pull ignorado: já houve recebimento há pouco');
      } else {
        if (target) {
          target.textContent = `Recebido em ${sec}s · ${result.products || 0} produtos · ${result.partners || 0} parceiros · ${result.sales || 0} vendas · ${result.purchases || 0} compras`;
        }
        toast(
          `Recebido: ${result.products || 0} produtos, ${result.partners || 0} parceiros, ${result.sales || 0} vendas, ${result.purchases || 0} compras`,
        );
      }
      window.dispatchEvent(new CustomEvent('vertice:company-changed', { detail: {} }));
    } catch (error) {
      if (target) target.textContent = error.message || 'Falha ao receber dados';
      toast(error.message || 'Falha ao receber dados');
    } finally {
      window.clearInterval(progressTimer);
      if (pullBtn) pullBtn.disabled = false;
      if (pushBtn) pushBtn.disabled = false;
    }
  });

  document.querySelector('#odoo-push')?.addEventListener('click', async () => {
    if (!confirm('Enviar todos os dados desta empresa ao Odoo (inventário, compras e vendas)?')) return;
    const target = syncStatus();
    const pullBtn = document.querySelector('#odoo-pull');
    const pushBtn = document.querySelector('#odoo-push');
    if (pullBtn) pullBtn.disabled = true;
    if (pushBtn) pushBtn.disabled = true;
    if (target) target.textContent = 'Enviando dados ao Odoo…';
    try {
      const result = await api('/api/forms/odoo/push', {
        method: 'POST',
        body: { kind: 'all' },
        timeoutMs: 5 * 60 * 1000,
      });
      if (target) target.textContent = `Envio concluído · ${result.ok || 0} ok · ${result.failed || 0} falhas`;
      toast(`Enviados ${result.ok}; falhas ${result.failed}`);
      if (result.errors?.length) console.warn(result.errors);
    } catch (error) {
      if (target) target.textContent = error.message || 'Falha ao enviar dados';
      toast(error.message || 'Falha ao enviar dados');
    } finally {
      if (pullBtn) pullBtn.disabled = false;
      if (pushBtn) pushBtn.disabled = false;
    }
  });
}

function bindOdooForm() {
  const testResult = () => document.querySelector('#odoo-test-result');

  document.querySelector('#odoo-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/forms/odoo/settings', { method: 'PUT', body: Object.fromEntries(form.entries()) });
      toast('Odoo salvo');
      testResult().textContent = 'Credenciais salvas.';
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelector('#test-odoo')?.addEventListener('click', async () => {
    const target = testResult();
    target.textContent = 'Testando…';
    try {
      const result = await api('/api/forms/odoo/status?live=1');
      target.textContent = result.connected
        ? `Conectado · ${result.version || 'Odoo'} · uid ${result.uid}`
        : result.error || 'Falha na conexão';
    } catch (error) {
      target.textContent = error.message;
    }
  });
}
