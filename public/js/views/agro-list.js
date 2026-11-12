import { escapeHtml, statCard } from '../ui.js';

export const AGRO_TABS = [
  { id: 'plantio', slug: 'plantio', label: 'Plantio', icon: 'sprout', description: 'O produtor é o fornecedor do Odoo. A estimativa da safra fica no plantio' },
  { id: 'colheita', slug: 'colheita', label: 'Colheita', icon: 'harvest', description: 'A quantidade colhida soma no estoque do talhão' },
  { id: 'entrega', slug: 'entrega', label: 'Entrega', icon: 'truck', description: 'Gera o pedido de venda e baixa o estoque do talhão' },
];

const STATUS = {
  planejado: 'Planejado',
  em_colheita: 'Em colheita',
  colhido: 'Colhido',
};

function dateBr(value) {
  const [year, month, day] = String(value || '').slice(0, 10).split('-');
  return year && month && day ? `${day}/${month}/${year}` : '—';
}

function qty(value, unit = '') {
  if (value == null || value === '') return '—';
  const text = Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  return unit ? `${text} ${unit}` : text;
}

function money(value) {
  if (value == null || value === '') return '—';
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function statusPill(status) {
  return `<span class="agro-status agro-status--${escapeHtml(status)}">${escapeHtml(STATUS[status] || status)}</span>`;
}

export function tabMeta(tab) {
  return AGRO_TABS.find((item) => item.id === tab) || AGRO_TABS[0];
}

function stats(tab, data) {
  const plantings = data.plantings || [];
  if (tab === 'colheita') {
    return [
      statCard({ label: 'Colheitas', value: (data.harvests || []).length, tone: 'green', icon: 'harvest' }),
      statCard({ label: 'Em colheita', value: plantings.filter((item) => item.status === 'em_colheita').length, tone: 'amber', icon: 'sprout' }),
      statCard({ label: 'Encerradas', value: plantings.filter((item) => item.status === 'colhido').length, tone: 'teal', icon: 'shield' }),
    ].join('');
  }
  if (tab === 'entrega') {
    const deliveries = data.deliveries || [];
    const total = deliveries.reduce((sum, item) => sum + Number(item.totalValue || 0), 0);
    return [
      statCard({ label: 'Entregas', value: deliveries.length, tone: 'orange', icon: 'truck' }),
      statCard({ label: 'Valor registrado', value: deliveries.length ? money(total) : '—', tone: 'blue', icon: 'money' }),
      statCard({
        label: 'Com saldo a entregar',
        value: plantings.filter((item) => item.harvestedQty - item.deliveredQty > 0.0001).length,
        tone: 'green',
        icon: 'box',
      }),
    ].join('');
  }
  return [
    statCard({ label: 'Plantios', value: plantings.length, tone: 'green', icon: 'sprout' }),
    statCard({ label: 'Em colheita', value: plantings.filter((item) => item.status === 'em_colheita').length, tone: 'amber', icon: 'harvest' }),
    statCard({ label: 'Colhidos', value: plantings.filter((item) => item.status === 'colhido').length, tone: 'teal', icon: 'shield' }),
  ].join('');
}

function buttons(kind, id, extra = '') {
  return `<td class="agro-actions">
    <button class="btn-ghost agro-mini" type="button" data-edit="${kind}" data-id="${escapeHtml(id)}">Editar</button>
    ${extra}
    <button class="btn-ghost agro-mini" type="button" data-delete="${kind}" data-id="${escapeHtml(id)}">Excluir</button>
  </td>`;
}

function table(headers, rows, empty) {
  if (!rows) return `<p class="muted">${escapeHtml(empty)}</p>`;
  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}<th>Ações</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function listHtml(tab, data) {
  if (tab === 'colheita') {
    const rows = (data.harvests || [])
      .map((item) => {
        const search = `${item.propertyName} ${item.plotName} ${item.productName}`.toLowerCase();
        const planting = (data.plantings || []).find((entry) => entry.id === item.plantingId);
        const remaining = planting ? planting.harvestedQty - planting.deliveredQty : 0;
        const deliver =
          remaining > 0.0001
            ? `<button class="btn-ghost agro-mini" type="button" data-go="entrega" data-planting="${escapeHtml(item.plantingId)}">Entregar</button>`
            : '';
        return `<tr data-search="${escapeHtml(search)}">
          <td>${dateBr(item.harvestedOn)}</td>
          <td>${escapeHtml(item.propertyName)}<span class="agro-sub">${escapeHtml(item.plotName || 'Sem talhão')}</span></td>
          <td>${escapeHtml(item.productName)}</td>
          <td>${qty(item.quantity, item.unit)}</td>
          <td>${statusPill(item.plantingStatus)}</td>
          ${buttons('colheita', item.id, deliver)}
        </tr>`;
      })
      .join('');
    return table(['Data', 'Propriedade', 'Produto', 'Quantidade', 'Plantio'], rows, 'Nenhuma colheita registrada.');
  }
  if (tab === 'entrega') {
    const rows = (data.deliveries || [])
      .map((item) => {
        const search = `${item.propertyName} ${item.partnerName} ${item.productName} ${item.document}`.toLowerCase();
        return `<tr data-search="${escapeHtml(search)}">
          <td>${dateBr(item.deliveredOn)}</td>
          <td>${escapeHtml(item.partnerName)}</td>
          <td>${escapeHtml(item.propertyName)}<span class="agro-sub">${escapeHtml(item.productName)}</span></td>
          <td>${qty(item.quantity, item.unit)}</td>
          <td>${money(item.unitPrice)}</td>
          <td>${money(item.totalValue)}</td>
          <td>${escapeHtml(item.document || '—')}</td>
          ${buttons('entrega', item.id)}
        </tr>`;
      })
      .join('');
    return table(['Data', 'Comprador', 'Origem', 'Quantidade', 'Unitário', 'Total', 'Documento'], rows, 'Nenhuma entrega registrada.');
  }
  const rows = (data.plantings || [])
    .map((item) => {
      const search = `${item.propertyName} ${item.producerName} ${item.plotName} ${item.productName}`.toLowerCase();
      const harvest =
        item.status === 'colhido'
          ? ''
          : `<button class="btn-ghost agro-mini" type="button" data-go="colheita" data-planting="${escapeHtml(item.id)}">Colher</button>`;
      return `<tr data-search="${escapeHtml(search)}">
        <td>${escapeHtml(item.propertyName)}</td>
        <td>${escapeHtml(item.producerName || '—')}</td>
        <td>${escapeHtml(item.plotName || '—')}</td>
        <td>${escapeHtml(item.productName)}<span class="agro-sub">${escapeHtml(item.unit || '')}</span></td>
        <td>${qty(item.areaPlanned, 'ha')}</td>
        <td>${dateBr(item.plantedOn)}</td>
        <td>${qty(item.forecastQty, item.unit)}</td>
        <td>${qty(item.harvestedQty, item.unit)}</td>
        <td>${statusPill(item.status)}</td>
        ${buttons('plantio', item.id, harvest)}
      </tr>`;
    })
    .join('');
  return table(
    ['Propriedade', 'Fornecedor', 'Talhão', 'Produto', 'Área', 'Plantio', 'Estimativa', 'Colhido', 'Situação'],
    rows,
    'Nenhum plantio nesta empresa.',
  );
}

export function shell(tab) {
  const meta = tabMeta(tab);
  return `
    <div class="view-pane forms-pane agro-pane">
      <div class="forms-toolbar">
        <header class="page-head">
          <h1>${escapeHtml(meta.label)}</h1>
          <p class="muted">${escapeHtml(meta.description)}. Os registros seguem a empresa ativa do Odoo.</p>
        </header>
        <div class="row forms-top-actions">
          <button class="btn-ghost" type="button" data-presets>Padrões</button>
          <button class="btn" type="button" data-new="${escapeHtml(tab)}">Novo</button>
        </div>
      </div>
      <div id="agro-body"></div>
    </div>`;
}

function emptyLabel(tab) {
  if (tab === 'colheita') return 'Nenhuma colheita registrada.';
  if (tab === 'entrega') return 'Nenhuma entrega registrada.';
  return 'Nenhum plantio nesta empresa.';
}

export function bodyHtml(tab, data) {
  const rows = tab === 'colheita' ? data.harvests : tab === 'entrega' ? data.deliveries : data.plantings;
  return `
    <div class="stat-row stat-row--3">${stats(tab, data)}</div>
    <section class="card data-results agro-panel">
      <div class="forms-filters">
        <label class="forms-filter-search">Busca
          <input data-filter placeholder="Propriedade, produto, talhão ou comprador" />
        </label>
      </div>
      ${rows?.length ? listHtml(tab, data) : `<p class="muted">${escapeHtml(emptyLabel(tab))}</p>`}
    </section>`;
}

