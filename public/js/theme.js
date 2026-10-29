const KEY = 'vertice-theme';

/** Tema fixo: claro (padrão Painel de Editais). */
export function getTheme() {
  return 'light';
}

export function applyTheme() {
  document.documentElement.dataset.theme = 'light';
  document.documentElement.style.colorScheme = 'light';
  try {
    localStorage.setItem(KEY, 'light');
  } catch {
    /* ignore */
  }
  return 'light';
}

export function initTheme() {
  return applyTheme();
}
