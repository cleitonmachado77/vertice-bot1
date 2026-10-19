/** Modal compartilhado do Vertice Forms (Compras / Inventário / Vendas / Cadastros). */

export function getFormsModal(root) {
  return (
    document.querySelector('body > #forms-modal') ||
    root?.querySelector('#forms-modal') ||
    document.getElementById('forms-modal')
  );
}

export function getFormsEditor(root) {
  return (
    getFormsModal(root)?.querySelector('#forms-editor') ||
    root?.querySelector('#forms-editor') ||
    document.getElementById('forms-editor')
  );
}

export function ensureFormsModal(root) {
  let modal = getFormsModal(root);
  if (modal) return modal;
  const host = root?.querySelector('#forms-body') || root || document.body;
  host.insertAdjacentHTML(
    'beforeend',
    `<div class="forms-modal" id="forms-modal" hidden>
      <div class="forms-modal-backdrop" data-close-modal tabindex="-1"></div>
      <section
        class="card forms-editor-card forms-modal-dialog"
        id="forms-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="forms-editor-title"
      ></section>
    </div>`,
  );
  return getFormsModal(root);
}

export function openEditorModal(root) {
  const modal = ensureFormsModal(root);
  if (!modal) return;
  if (modal.parentElement !== document.body) {
    document.body.appendChild(modal);
  }
  modal.hidden = false;
  modal.classList.add('is-open');
  document.body.classList.add('forms-modal-open');
  const onKey = (event) => {
    if (event.key === 'Escape') {
      closeEditorModal(root);
      document.removeEventListener('keydown', onKey);
    }
  };
  document.removeEventListener('keydown', modal._formsEsc);
  modal._formsEsc = onKey;
  document.addEventListener('keydown', onKey);
  modal.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.onclick = () => closeEditorModal(root);
  });
}

export function closeEditorModal(root) {
  const modal = getFormsModal(root);
  if (!modal) return;
  document.querySelectorAll('body > .forms-combo-menu').forEach((el) => {
    el.hidden = true;
    el.innerHTML = '';
    el.removeAttribute('style');
  });
  document.querySelectorAll('.forms-combo.is-open').forEach((el) => el.classList.remove('is-open'));
  modal.hidden = true;
  modal.classList.remove('is-open');
  document.body.classList.remove('forms-modal-open');
  if (modal._formsEsc) {
    document.removeEventListener('keydown', modal._formsEsc);
    delete modal._formsEsc;
  }
  root?.querySelectorAll('.forms-list-item.active').forEach((el) => el.classList.remove('active'));
}

export function formsModalShellHtml() {
  return `<div class="forms-modal" id="forms-modal" hidden>
    <div class="forms-modal-backdrop" data-close-modal tabindex="-1"></div>
    <section
      class="card forms-editor-card forms-modal-dialog"
      id="forms-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="forms-editor-title"
    ></section>
  </div>`;
}
