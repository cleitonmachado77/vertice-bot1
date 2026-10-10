export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
