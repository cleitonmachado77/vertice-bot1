import { api } from '../api.js';
import { escapeHtml, toast } from '../ui.js';
import { findFardoPresets, foldName } from './forms-fardo.js';
import {
  closeEditorModal,
  ensureFormsModal,
  getFormsEditor,
  openEditorModal,
} from './forms-modal.js';

export async function loadPresets(kind) {
  const data = await api(`/api/forms/presets?kind=${encodeURIComponent(kind)}`);
  return Array.isArray(data.items) ? data.items : [];
}

export function presetsToolbarHtml(presets, kind = '') {
  if (kind === 'production') return productionPresetsToolbarHtml(presets);
  const buttons = (presets || [])
    .map(
      (preset) =>
        `<button class="btn forms-preset-btn" type="button" data-preset-new="${escapeHtml(preset.id)}" title="Novo com padrão ${escapeHtml(preset.name)}${preset.bot_enabled ? ' · Bot ativo' : ''}">${escapeHtml(preset.name)}${preset.bot_enabled ? ' · Bot' : ''}</button>`,
    )
    .join('');
  return `${buttons}<button class="btn-ghost" type="button" data-presets>Padrões</button>`;
}

function productionPresetsToolbarHtml(presets) {
  const { comBags, semBags } = findFardoPresets(presets);
  const used = new Set([comBags?.id, semBags?.id].filter(Boolean));
  const parts = [];
  if (comBags) {
    parts.push(
      `<button class="btn forms-preset-btn" type="button" data-preset-new="${escapeHtml(comBags.id)}" title="Converter bags em fardos${comBags.bot_enabled ? ' · Bot ativo' : ''}">Fardos com bags${comBags.bot_enabled ? ' · Bot' : ''}</button>`,
    );
  } else {
    parts.push(
      `<button class="btn forms-preset-btn" type="button" data-fardo-flow-new="converter_bags" title="Criar registro convertendo bags em fardos">Fardos com bags</button>`,
    );
  }
  if (semBags) {
    parts.push(
      `<button class="btn forms-preset-btn" type="button" data-preset-new="${escapeHtml(semBags.id)}" title="Registrar fardos sem consumir bags${semBags.bot_enabled ? ' · Bot ativo' : ''}">Fardos sem bags${semBags.bot_enabled ? ' · Bot' : ''}</button>`,
    );
  } else {
    parts.push(
      `<button class="btn forms-preset-btn" type="button" data-fardo-flow-new="entrega_direta" title="Criar registro de fardos sem bags">Fardos sem bags</button>`,
    );
  }
  const others = (presets || []).filter((preset) => !used.has(preset.id));
  for (const preset of others) {
    parts.push(
      `<button class="btn-ghost forms-preset-btn" type="button" data-preset-new="${escapeHtml(preset.id)}" title="Novo com padrão ${escapeHtml(preset.name)}${preset.bot_enabled ? ' · Bot ativo' : ''}">${escapeHtml(preset.name)}${preset.bot_enabled ? ' · Bot' : ''}</button>`,
    );
  }
  parts.push(`<button class="btn-ghost" type="button" data-presets>Padrões</button>`);
  return parts.join('');
}

/** Modal rápido: novo padrão de Prensagem com bags / sem bags / em branco. */
export function openProductionPresetChooser(root, hooks) {
  ensureFormsModal(root);
  const editor = getFormsEditor(root);
  if (!editor) {
    toast('Não foi possível abrir o seletor de padrões');
    return;
  }
  editor.innerHTML = `
    <div class="card-head forms-editor-head">
      <div>
        <h2 id="forms-editor-title">Novo padrão de Prensagem</h2>
        <p class="muted">Escolha o fluxo de fardos. O Bot usa o mesmo padrão no WhatsApp.</p>
      </div>
      <div class="row">
        <button class="btn-ghost" type="button" data-close-modal>Fechar</button>
      </div>
    </div>
    <div class="forms-presets-list">
      <div class="forms-presets-row">
        <div>
          <strong>Fardos com bags</strong>
          <span class="muted">Converter BAGS para Fardos — consome bags e gera fardos</span>
        </div>
        <div class="row">
          <button class="btn" type="button" data-fardo-preset-template="converter_bags">Usar este</button>
        </div>
      </div>
      <div class="forms-presets-row">
        <div>
          <strong>Fardos sem bags</strong>
          <span class="muted">Entrega de Fardos — registra só a produção de fardos</span>
        </div>
        <div class="row">
          <button class="btn" type="button" data-fardo-preset-template="entrega_direta">Usar este</button>
        </div>
      </div>
      <div class="forms-presets-row">
        <div>
          <strong>Em branco</strong>
          <span class="muted">Prensagem genérica (ordem de fabricação livre)</span>
        </div>
        <div class="row">
          <button class="btn-ghost" type="button" data-fardo-preset-template="blank">Criar</button>
        </div>
      </div>
    </div>`;
  openEditorModal(root);
  editor.querySelector('[data-close-modal]')?.addEventListener('click', () => closeEditorModal(root));
  editor.querySelectorAll('[data-fardo-preset-template]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const template = btn.getAttribute('data-fardo-preset-template') || 'blank';
      hooks.openPresetFromTemplate(template);
    });
  });
}

export function productionPresetDisplayName(preset) {
  const flow = foldName(preset?.name || '');
  if (flow.includes('converter') || (flow.includes('bag') && flow.includes('fardo'))) return 'Fardos com bags';
  if (flow.includes('entrega') && flow.includes('fardo')) return 'Fardos sem bags';
  return preset?.name || 'Padrão';
}

/** Mesma regra do servidor (statusesFor): Inventário não tem status. */
function hasStatuses(kind) {
  return kind !== 'product';
}

/** Default: mostra editáveis; readonly (ex.: número) fica oculto no novo. */
export function defaultPresetVisible(fields, kind) {
  return {
    title: true,
    status: hasStatuses(kind),
    header: (fields?.header || []).filter((field) => !field.readonly).map((field) => field.key),
    lines: (fields?.lines || []).map((field) => field.key),
  };
}

export function normalizePresetVisible(preset, fields, kind) {
  const fallback = defaultPresetVisible(fields, kind);
  const raw = preset?.visible;
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    title: raw.title == null ? fallback.title : Boolean(raw.title),
    status: !hasStatuses(kind) ? false : raw.status == null ? fallback.status : Boolean(raw.status),
    header: Array.isArray(raw.header) ? raw.header.map(String) : fallback.header,
    lines: Array.isArray(raw.lines) ? raw.lines.map(String) : fallback.lines,
  };
}

export function draftFromPreset(blankDraft, preset, fields) {
  const kind = blankDraft.kind || preset.kind;
  const draft = {
    ...blankDraft,
    title: typeof preset.title === 'string' ? preset.title : blankDraft.title,
    status: preset.status || blankDraft.status || 'draft',
    header: { ...(blankDraft.header || {}), ...(preset.header || {}) },
    lines: blankDraft.lines || [],
  };
  if (Array.isArray(preset.lines)) {
    draft.lines = preset.lines.map((line) => ({
      id: '',
      values: { ...(line.values || {}) },
    }));
  }

  const visible = normalizePresetVisible(preset, fields, kind);
  const showHeader = new Set(visible.header || []);
  const showLineKeys = new Set(visible.lines || []);
  const headerKeys = (fields?.header || []).map((field) => field.key);
  const lineKeys = (fields?.lines || []).map((field) => field.key);

  const lineHideSet = new Set(lineKeys.filter((key) => !showLineKeys.has(key)));
  const hide = {
    title: !visible.title,
    status: !visible.status,
    header: new Set(headerKeys.filter((key) => !showHeader.has(key))),
    // Sempre pelo menos um Set — “Adicionar linha” reutiliza o mesmo filtro.
    lines: (draft.lines || []).length
      ? (draft.lines || []).map(() => new Set(lineHideSet))
      : [new Set(lineHideSet)],
  };
  return { draft, hide, visible };
}

export function collectPresetVisible(form, fields) {
  const data = new FormData(form);
  return {
    title: data.get('show_title') === '1',
    status: data.get('show_status') === '1',
    header: (fields.header || [])
      .filter((field) => data.get(`show_h_${field.key}`) === '1')
      .map((field) => field.key),
    lines: (fields.lines || [])
      .filter((field) => data.get(`show_l_${field.key}`) === '1')
      .map((field) => field.key),
  };
}

/**
 * Modal de gerenciamento: lista, criar, editar, excluir.
 * `hooks` fornece abertura do editor de padrão e refresh da toolbar.
 */
export function openPresetsManager(root, kind, presets, hooks) {
  ensureFormsModal(root);
  const editor = getFormsEditor(root);
  if (!editor) {
    toast('Não foi possível abrir o gerenciador de padrões');
    return;
  }

  const paintList = (items) => {
    editor.innerHTML = `
      <div class="card-head forms-editor-head">
        <div>
          <h2 id="forms-editor-title">Padrões</h2>
          <p class="muted">Campos “Mostrar” definem o formulário e, se Bot estiver ativo, as perguntas no WhatsApp.</p>
        </div>
        <div class="row">
          <button class="btn" type="button" data-preset-create>Novo padrão</button>
          <button class="btn-ghost" type="button" data-close-modal>Fechar</button>
        </div>
      </div>
      <div class="forms-presets-list" id="forms-presets-list">
        ${
          items.length
            ? items
                .map(
                  (preset) => `
          <div class="forms-presets-row" data-preset-id="${escapeHtml(preset.id)}">
            <div>
              <strong>${escapeHtml(preset.name)}</strong>
              <span class="muted">${escapeHtml(preset.status || 'draft')}${preset.bot_enabled ? ' · Bot ativo' : ''}</span>
            </div>
            <div class="row">
              ${
                preset.bot_enabled
                  ? `<button class="btn" type="button" data-preset-bot-send="${escapeHtml(preset.id)}">Enviar agora</button>`
                  : ''
              }
              <button class="btn-ghost" type="button" data-preset-edit="${escapeHtml(preset.id)}">Editar</button>
              <button class="btn-danger" type="button" data-preset-delete="${escapeHtml(preset.id)}">Excluir</button>
            </div>
          </div>`,
                )
                .join('')
            : `<p class="muted forms-presets-empty">Nenhum padrão nesta empresa. Crie um para acelerar novos registros.</p>`
        }
      </div>`;
    openEditorModal(root);
    editor.querySelector('[data-close-modal]')?.addEventListener('click', () => closeEditorModal(root));
    editor.querySelector('[data-preset-create]')?.addEventListener('click', () => {
      if (kind === 'production' && typeof hooks.openProductionPresetChooser === 'function') {
        hooks.openProductionPresetChooser();
        return;
      }
      hooks.openPresetEditor(null);
    });
    editor.querySelectorAll('[data-preset-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-preset-edit');
        try {
          const fresh = await loadPresets(kind);
          const preset = fresh.find((item) => item.id === id) || null;
          if (!preset) {
            toast('Padrão não encontrado');
            return;
          }
          hooks.openPresetEditor(preset);
        } catch (error) {
          toast(error.message || 'Falha ao abrir padrão');
        }
      });
    });
    editor.querySelectorAll('[data-preset-bot-send]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-preset-bot-send');
        if (!id) return;
        btn.disabled = true;
        try {
          const result = await api(`/api/forms/presets/${encodeURIComponent(id)}/bot-send`, {
            method: 'POST',
            body: {},
          });
          toast(`Perguntas enviadas para ${result.phone || 'WhatsApp'}`);
        } catch (error) {
          toast(error.message || 'Falha ao enviar pelo Bot');
        } finally {
          btn.disabled = false;
        }
      });
    });
    editor.querySelectorAll('[data-preset-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-preset-delete');
        const preset = items.find((item) => item.id === id);
        if (!preset) return;
        if (!confirm(`Excluir o padrão "${preset.name}"?`)) return;
        try {
          await api(`/api/forms/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('Padrão excluído', { tone: 'subtle' });
          const next = await loadPresets(kind);
          await hooks.onPresetsChanged(next);
          paintList(next);
        } catch (error) {
          toast(error.message || 'Falha ao excluir');
        }
      });
    });
  };

  paintList(presets || []);
}
