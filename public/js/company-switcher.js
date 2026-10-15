import { api } from './api.js';
import { escapeHtml, toast } from './ui.js';

const STORAGE_KEY = 'vertice-company-switcher';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached = null;
let fetching = null;

function shortName(name) {
  const value = String(name || '').trim();
  if (value.length <= 36) return value;
  return `${value.slice(0, 33)}…`;
}

function readStored() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.items?.length) return null;
    return data;
  } catch {
    return null;
  }
}

function writeStored(data) {
  try {
    const active = data.items?.find((item) => item.id === data.activeId) || data.items?.[0] || null;
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        items: data.items || [],
        activeId: active?.id || data.activeId || '',
        at: Date.now(),
      }),
    );
  } catch {
    /* ignore quota */
  }
}

export async function loadCompanies(force = false) {
  if (!force && cached?.at && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  if (!force && fetching) return fetching;
  fetching = api('/api/forms/companies')
    .then((data) => {
      cached = { ...data, at: Date.now() };
      writeStored(cached);
      return cached;
    })
    .finally(() => {
      fetching = null;
    });
  return fetching;
}

export async function mountCompanySwitcher(host) {
  if (!host) return;

  const instant = cached || readStored();
  if (instant?.items?.length) {
    paintSwitcher(host, instant);
  } else {
    paintSwitcher(host, { items: [], activeId: '' }, { pending: true });
  }

  try {
    const data = await loadCompanies(false);
    if (!host.isConnected) return;
    paintSwitcher(host, data);
  } catch (error) {
    if (!host.isConnected) return;
    if (!host.querySelector('[data-company-switcher]')) {
      paintSwitcher(host, { items: [], activeId: '' }, { error: error.message });
    }
  }
}

function paintSwitcher(host, data, meta = {}) {
  const items = data.items || [];
  const activeId = data.activeId || '';
  const active = items.find((item) => item.id === activeId) || items[0];
  const pending = Boolean(meta.pending);
  const error = meta.error || '';

  const label = pending
    ? '…'
    : error
      ? 'Sem empresas'
      : shortName(active?.name || 'Selecionar');

  host.innerHTML = `
    <div class="company-switcher${pending ? ' is-pending' : ''}" data-company-switcher>
      <button type="button" class="company-switcher-btn" data-company-toggle
        aria-haspopup="listbox" aria-expanded="false"
        ${pending || (!items.length && !error) ? 'disabled' : ''}
        title="${escapeHtml(error || active?.name || 'Empresa')}">
        <span class="company-switcher-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>
          </svg>
        </span>
        <span class="company-switcher-text">
          <span class="company-switcher-kicker">Empresa</span>
          <span class="company-switcher-name">${escapeHtml(label)}</span>
        </span>
        <span class="company-switcher-caret" aria-hidden="true">▾</span>
      </button>
      <div class="company-switcher-menu" hidden role="listbox">
        ${
          items.length
            ? items
                .map(
                  (item) => `
          <button type="button" class="company-switcher-option${item.id === active?.id ? ' is-active' : ''}"
            role="option" data-company-id="${escapeHtml(item.id)}" aria-selected="${item.id === active?.id}">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${escapeHtml([item.vat && `CNPJ ${item.vat}`, item.currency].filter(Boolean).join(' · ') || 'Odoo')}</span>
          </button>`,
                )
                .join('')
            : `<p class="company-switcher-empty-msg muted">${escapeHtml(error || 'Nenhuma empresa carregada')}</p>`
        }
        <button type="button" class="company-switcher-option company-switcher-sync" data-sync-companies>
          Atualizar lista do Odoo
        </button>
      </div>
    </div>`;

  bindSwitcher(host);
}

function bindSwitcher(host) {
  const toggle = host.querySelector('[data-company-toggle]');
  const menu = host.querySelector('.company-switcher-menu');
  if (!toggle || !menu) return;

  const close = () => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    if (toggle.disabled) return;
    const open = menu.hidden;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const onDoc = () => close();
      setTimeout(() => document.addEventListener('click', onDoc, { once: true }), 0);
    }
  });

  menu.addEventListener('click', (event) => event.stopPropagation());

  host.querySelectorAll('[data-company-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-company-id');
      try {
        const data = await api('/api/forms/companies/active', { method: 'PUT', body: { activeId: id } });
        cached = { ...data, at: Date.now() };
        writeStored(cached);
        close();
        paintSwitcher(host, cached);
        window.dispatchEvent(new CustomEvent('vertice:company-changed', { detail: { activeId: id } }));
        toast('Empresa ativa atualizada');
      } catch (error) {
        toast(error.message);
      }
    });
  });

  host.querySelector('[data-sync-companies]')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/forms/companies/sync', { method: 'POST', body: {} });
      cached = { ...data, at: Date.now() };
      writeStored(cached);
      paintSwitcher(host, cached);
      toast('Empresas sincronizadas');
    } catch (error) {
      toast(error.message);
    }
  });
}
