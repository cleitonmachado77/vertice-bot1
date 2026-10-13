let sessionCache = null;
let sessionAt = 0;
const SESSION_TTL_MS = 60_000;

export function invalidateSession() {
  sessionCache = null;
  sessionAt = 0;
}

export async function ensureSession(force = false) {
  if (!force && sessionCache && Date.now() - sessionAt < SESSION_TTL_MS) {
    return sessionCache;
  }
  const me = await api('/api/me');
  sessionCache = me;
  sessionAt = Date.now();
  return me;
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    invalidateSession();
    if (path !== '/api/login' && path !== '/api/me') {
      location.hash = '#/login';
    }
  }
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir');
  return data;
}
