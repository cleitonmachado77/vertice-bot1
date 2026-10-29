import { icon } from './icons.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Card de estatística com ícone colorido (padrão Painel de Editais).
 * @param {{ label: string, value: string | number, hint?: string, tone?: string, icon?: string, href?: string, title?: string, loading?: boolean }} opts
 */
export function statCard({ label, value, hint = '', tone = 'orange', icon: iconName = 'dashboard', href = '', title = '', loading = false }) {
  const tag = href ? 'a' : 'article';
  const attrs = [
    `class="stat-card tone-${escapeHtml(tone)}${loading ? ' is-loading' : ''}"`,
    href ? `href="${escapeHtml(href)}"` : '',
    title ? `title="${escapeHtml(title)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <${tag} ${attrs}>
      <span class="stat-card-icon">${icon(iconName)}</span>
      <span class="stat-card-copy">
        <span class="stat-card-value">${escapeHtml(loading ? '…' : value)}</span>
        <span class="stat-card-label">${escapeHtml(label)}</span>
        ${hint ? `<span class="stat-card-hint">${escapeHtml(hint)}</span>` : ''}
      </span>
    </${tag}>`;
}

/** Card de ação rápida: ícone + título + descrição. */
export function actionCard({ href, title, description = '', icon: iconName = 'chevron', tone = 'orange' }) {
  return `
    <a class="action-card tone-${escapeHtml(tone)}" href="${escapeHtml(href)}">
      <span class="action-card-icon">${icon(iconName)}</span>
      <span>
        <strong>${escapeHtml(title)}</strong>
        ${description ? `<span class="muted">${escapeHtml(description)}</span>` : ''}
      </span>
    </a>`;
}

export function viewLoading(label = 'Carregando…') {
  return `
    <div class="view-pane view-loading" aria-busy="true">
      <div class="loading-block">
        <span class="loading-spinner" aria-hidden="true"></span>
        <p class="muted">${escapeHtml(label)}</p>
      </div>
    </div>`;
}

export function panelLoading(label = 'Carregando…') {
  return `
    <div class="panel-loading" aria-busy="true">
      <span class="loading-spinner" aria-hidden="true"></span>
      <p class="muted">${escapeHtml(label)}</p>
    </div>`;
}

/** Poll that pauses when the tab is hidden. Returns a stop function. */
export function createPoll(fn, intervalMs = 8000) {
  let timer = 0;
  let stopped = false;
  const run = () => {
    if (stopped || document.hidden) return;
    Promise.resolve()
      .then(fn)
      .catch(() => {});
  };
  const onVisibility = () => {
    if (!stopped && !document.hidden) run();
  };
  document.addEventListener('visibilitychange', onVisibility);
  timer = setInterval(run, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = 0;
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * @param {string} message
 * @param {{ tone?: 'default' | 'subtle' | 'error', ms?: number }} [options]
 */
export function toast(message, options = {}) {
  const tone = options.tone || 'default';
  const ms = options.ms ?? (tone === 'error' ? 6200 : tone === 'subtle' ? 4800 : 3200);
  const node = document.createElement('div');
  node.className = `toast${tone === 'subtle' ? ' toast-subtle' : ''}${tone === 'error' ? ' toast-error' : ''}`;
  node.textContent = String(message || '');
  document.body.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

/** Extrai a mensagem útil de erros Odoo/RPC longos. */
export function formatSyncError(raw, maxLen = 280) {
  let text = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Falha ao sincronizar com o Odoo';
  // Remove prefixos comuns de RPC / traceback curto
  text = text
    .replace(/^Odoo Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/^ValidationError:\s*/i, '')
    .replace(/^UserError:\s*/i, '');
  const missing = text.match(/Missing required field '[^']+'[^.]*(?:\.[^.]*)?/i);
  if (missing) text = missing[0].replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1)}…`;
  return text;
}

export function displayName(name, phone) {
  const clean = String(name || '').trim();
  if (!clean) return '';
  const letters = clean.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (!letters) return '';
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  const nameDigits = clean.replace(/\D/g, '');
  if (phoneDigits && nameDigits && (nameDigits === phoneDigits || phoneDigits.endsWith(nameDigits) || nameDigits.endsWith(phoneDigits))) {
    return '';
  }
  return clean;
}

export function formatWhen(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function initials(value) {
  const raw = String(value || '').trim();
  const compact = raw.replace(/\s/g, '');
  const digits = compact.replace(/\D/g, '');
  if (digits.length >= 2 && digits.length >= compact.length - 1) return digits.slice(-2);
  const parts = raw.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const letters = (parts[0][0] || '') + (parts[1]?.[0] || '');
  return letters.toUpperCase();
}
