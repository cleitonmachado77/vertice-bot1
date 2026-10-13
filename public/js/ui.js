export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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

export function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
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
