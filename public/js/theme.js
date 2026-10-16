const KEY = 'vertice-theme';

/** Tema fixo: apenas dark. */
export function getTheme() {
  return 'dark';
}

export function applyTheme() {
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.style.colorScheme = 'dark';
  try {
    localStorage.setItem(KEY, 'dark');
  } catch {
    /* ignore */
  }
  return 'dark';
}

export function initTheme() {
  return applyTheme();
}
