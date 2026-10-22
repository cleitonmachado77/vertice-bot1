import { api } from '../api.js';
import { escapeHtml, panelLoading } from '../ui.js';
import { getNavToken, isNavActive } from '../nav.js';

const KIND_META = {
  purchase: { label: 'Compras', href: '#/forms/compras' },
  product: { label: 'Inventário', href: '#/forms/inventario' },
  sale: { label: 'Vendas', href: '#/forms/vendas' },
};

/** @type {string} */
let filterId = '';

export async function renderQuestionnaires(root, token = getNavToken()) {
  root.innerHTML = `
    <div class="view-pane">
      <div class="top">
        <div>
          <h1>Análise</h1>
        </div>
      </div>
      <div id="questionnaires-panel">${panelLoading()}</div>
    </div>`;

  if (!isNavActive(token)) return;
  await renderAnalytics(root.querySelector('#questionnaires-panel'), token);
}

async function renderAnalytics(root, token = getNavToken()) {
  if (!root) return;
  root.innerHTML = panelLoading('Carregando análise…');

  const [questionnairesPack, dataPack, ...presetPacks] = await Promise.all([
    api('/api/questionnaires'),
    api('/api/questionnaires/data'),
    api('/api/forms/presets?kind=purchase').catch(() => ({ items: [] })),
    api('/api/forms/presets?kind=product').catch(() => ({ items: [] })),
    api('/api/forms/presets?kind=sale').catch(() => ({ items: [] })),
  ]);
  if (!isNavActive(token)) return;

  const presetsById = new Map();
  for (const [kind, pack] of [
    ['purchase', presetPacks[0]],
    ['product', presetPacks[1]],
    ['sale', presetPacks[2]],
  ]) {
    for (const preset of pack?.items || []) {
      if (preset.bot_enabled) {
        presetsById.set(preset.id, { ...preset, kind });
      }
    }
  }

  const formsQuestionnaires = (questionnairesPack.items || []).filter(
    (item) => item.sourcePresetId || String(item.name || '').startsWith('[Forms]'),
  );

  /** Ativos = padrão Bot ligado e/ou questionário Forms ativo. */
  const activeRows = [];
  const seenPreset = new Set();

  for (const q of formsQuestionnaires) {
    const preset = q.sourcePresetId ? presetsById.get(q.sourcePresetId) : null;
    const kind = q.formKind || preset?.kind || '';
    const meta = KIND_META[kind] || { label: kind || 'Forms', href: '#/forms/compras' };
    if (q.sourcePresetId) seenPreset.add(q.sourcePresetId);
    activeRows.push({
      id: q.id,
      name: preset?.name || cleanQuestionnaireName(q.name),
      kind,
      kindLabel: meta.label,
      kindHref: meta.href,
      active: Number(q.active) === 1,
      questions: q.questions?.length || 0,
      presetId: q.sourcePresetId || '',
      fromPreset: Boolean(preset),
    });
  }

  for (const [presetId, preset] of presetsById) {
    if (seenPreset.has(presetId)) continue;
    const meta = KIND_META[preset.kind] || { label: preset.kind, href: '#/forms/compras' };
    activeRows.push({
      id: `preset:${presetId}`,
      name: preset.name,
      kind: preset.kind,
      kindLabel: meta.label,
      kindHref: meta.href,
      active: true,
      questions: countPresetQuestions(preset),
      presetId,
      fromPreset: true,
      pendingSync: true,
    });
  }

  activeRows.sort((a, b) => {
    const kindOrder = { purchase: 0, product: 1, sale: 2 };
    return (
      (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) ||
      a.name.localeCompare(b.name, 'pt-BR')
    );
  });

  const allAnswers = dataPack.items || [];
  const answerFilterIds = new Set(
    formsQuestionnaires.map((item) => item.id).filter(Boolean),
  );
  // Só ciclos ligados a Padrões Forms — nunca exibe legado de planilha.
  const formsAnswers = answerFilterIds.size
    ? allAnswers.filter((item) => answerFilterIds.has(item.questionnaire_id))
    : [];
  const visibleAnswers = formsAnswers.filter(
    (item) => !filterId || item.questionnaire_id === filterId,
  );

  const answered = visibleAnswers.filter((item) => item.answer_text).length;
  const cycles = new Set(visibleAnswers.map((item) => item.cycle_id).filter(Boolean));
  const completed = new Set(
    visibleAnswers
      .filter((item) => item.cycle_status === 'completed')
      .map((item) => item.cycle_id),
  ).size;

  const filterOptions = formsQuestionnaires
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}" ${item.id === filterId ? 'selected' : ''}>${escapeHtml(
          cleanQuestionnaireName(item.name),
        )}</option>`,
    )
    .join('');

  root.innerHTML = `
    <div class="data-layout bot-analytics">
      <section class="card stack">
        <div class="card-head">
          <h2>Questionários ativos</h2>
        </div>
        ${
          activeRows.length
            ? `<div class="bot-active-grid">${activeRows.map(activeCard).join('')}</div>`
            : `<div class="data-empty">
                <strong>Nenhum questionário ativo</strong>
                <p class="muted">Ative “Enviar perguntas pelo Vertice Bot” em um Padrão do Forms.</p>
              </div>`
        }
      </section>

      <section class="card data-toolbar">
        <div class="card-head">
          <h2>Respostas</h2>
        </div>
        <div class="data-toolbar-row">
          <div class="data-filter-field">
            <label>Questionário</label>
            <select id="data-filter">
              <option value="">Todos</option>
              ${filterOptions}
            </select>
          </div>
          <div class="data-stats">
            <div class="data-stat">
              <span class="muted">Respostas</span>
              <strong>${answered}</strong>
            </div>
            <div class="data-stat">
              <span class="muted">Ciclos</span>
              <strong>${cycles.size}</strong>
            </div>
            <div class="data-stat">
              <span class="muted">Concluídos</span>
              <strong>${completed}</strong>
            </div>
          </div>
        </div>
      </section>

      <section class="card stack data-results">
        ${
          visibleAnswers.length
            ? `<div class="data-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Gestor</th>
                      <th>Questionário</th>
                      <th>Pergunta</th>
                      <th>Resposta</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>${visibleAnswers.map(dataRow).join('')}</tbody>
                </table>
              </div>`
            : `<div class="data-empty">
                <strong>Nenhuma resposta ainda</strong>
                <p class="muted">Quando o gestor responder no WhatsApp, as respostas aparecem aqui.</p>
              </div>`
        }
      </section>
    </div>`;

  root.querySelector('#data-filter')?.addEventListener('change', async (event) => {
    filterId = event.target.value || '';
    await renderAnalytics(root, token);
  });
}

function countPresetQuestions(preset) {
  const header = Array.isArray(preset.visible?.header) ? preset.visible.header.length : 0;
  const hasLines = Array.isArray(preset.visible?.lines) && preset.visible.lines.length > 0;
  let count = 0;
  for (const key of preset.visible?.header || []) {
    if (!String(preset.header?.[key] || '').trim()) count += 1;
  }
  if (hasLines) {
    const hasLineDefaults = (preset.lines || []).some((line) =>
      Object.values(line.values || {}).some((value) => String(value || '').trim()),
    );
    if (!hasLineDefaults) count += 1;
  }
  return count || header;
}

function cleanQuestionnaireName(name) {
  return String(name || '')
    .replace(/^\[Forms\]\s*/i, '')
    .trim();
}

function activeCard(row) {
  const status = row.pendingSync
    ? 'Aguardando sync'
    : row.active
      ? 'Ativo'
      : 'Pausado';
  return `
    <article class="q-list-card bot-active-card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <strong>${escapeHtml(row.name)}</strong>
          <p class="muted" style="margin: 6px 0 0;">${escapeHtml(row.kindLabel)} · ${row.questions} pergunta${row.questions === 1 ? '' : 's'}</p>
        </div>
        <span class="pill ${row.active || row.pendingSync ? '' : 'off'}">${escapeHtml(status)}</span>
      </div>
      <p class="muted q-list-preview">Origem: Padrão no Vertice Forms (${escapeHtml(row.kindLabel)}).</p>
      <div class="row">
        <a class="btn-ghost" href="${escapeHtml(row.kindHref)}">Ver no Forms</a>
      </div>
    </article>`;
}

function dataRow(item) {
  const status =
    item.cycle_status === 'completed'
      ? 'Concluído → Forms'
      : item.cycle_status === 'notified'
        ? 'Aguardando'
        : item.cycle_status === 'in_progress'
          ? 'Em andamento'
          : item.cycle_status === 'open'
            ? 'Aberto'
            : escapeHtml(item.cycle_status || '-');
  return `
    <tr>
      <td class="data-date">${escapeHtml(item.occurrence_date || '')}</td>
      <td>
        <strong>${escapeHtml(item.contact_name || 'Gestor')}</strong>
        <div class="muted">${escapeHtml(item.contact_phone || '')}</div>
      </td>
      <td>${escapeHtml(cleanQuestionnaireName(item.questionnaire_name || ''))}</td>
      <td>${escapeHtml(item.question_body || '')}</td>
      <td class="data-answer">
        ${escapeHtml(item.answer_text || '—')}
        ${
          item.media_url
            ? `<div class="muted"><a href="${escapeHtml(item.media_url)}" target="_blank" rel="noopener">Ver mídia</a></div>`
            : ''
        }
      </td>
      <td><span class="pill ${item.cycle_status === 'completed' ? '' : 'off'}">${status}</span></td>
    </tr>`;
}
