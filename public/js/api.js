export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/login' && path !== '/api/me') {
    location.hash = '#/login';
  }
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir');
  return data;
}
