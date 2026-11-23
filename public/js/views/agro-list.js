import { escapeHtml, statCard } from '../ui.js';

export const AGRO_TABS = [
  {
    id: 'dashboard',
    slug: 'dashboard',
    label: 'Dashboard',
    icon: 'dashboard',
    description: 'Indicadores de plantio, colheita, entrega e custos da empresa ativa',
  },
  { id: 'plantio', slug: 'plantio', label: 'Plantio', icon: 'sprout', description: 'O produtor é o fornecedor do Odoo. A estimativa da safra fica no plantio' },
  { id: 'colheita', slug: 'colheita', label: 'Colheita', icon: 'harvest', description: 'A quantidade colhida soma no estoque do talhão' },
  {
    id: 'entrega',
    slug: 'entrega',
    label: 'Entrega',
    icon: 'truck',
    description: 'Entrega nos locais cadastrados (Sacolão, escolas, Coara…). Gera pedido no Odoo',
  },
  { id: 'custos', slug: 'custos', label: 'Custos', icon: 'money', description: 'Registra os custos por área (talhão) da empresa ativa' },
  {
    id: 'configuracoes',
    slug: 'configuracoes',
    label: 'Configurações',
    icon: 'settings',
    description: 'Produtor, propriedades e talhões centralizados para o Agro e o Bot',
  },
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

export function productSigla(catalog, productId, productName) {
  const product = (catalog?.products || []).find((item) => item.id && item.id === productId);
  const sigla = String(product?.sigla || '').trim();
  return sigla || String(productName || '').trim() || '—';
}

function avgSalePrice(data, productName, productId) {
  const deliveries = (data.deliveries || []).filter((item) => item.productName === productName);
  let value = 0;
  let quantity = 0;
  for (const item of deliveries) {
    value += Number(item.totalValue || 0);
    quantity += Number(item.quantity || 0);
  }
  if (quantity > 0) return value / quantity;
  const product = (data.catalog?.products || []).find((item) => item.id === productId);
  const fallback = Number(String(product?.salesPrice || '').replace(',', '.'));
  return Number.isFinite(fallback) ? fallback : 0;
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
  if (tab === 'custos') {
    const costs = data.costs || [];
    const total = costs.reduce((sum, item) => sum + Number(item.totalValue != null ? item.totalValue : item.quantity || 0), 0);
    return [
      statCard({ label: 'Lançamentos', value: costs.length, tone: 'amber', icon: 'money' }),
      statCard({ label: 'Valor / quantidade', value: costs.length ? money(total) : '—', tone: 'orange', icon: 'box' }),
      statCard({
        label: 'Áreas com custo',
        value: new Set(costs.map((item) => item.plotId).filter(Boolean)).size,
        tone: 'green',
        icon: 'sprout',
      }),
    ].join('');
  }
  return [
    statCard({ label: 'Plantios', value: plantings.length, tone: 'green', icon: 'sprout' }),
    statCard({ label: 'Em colheita', value: plantings.filter((item) => item.status === 'em_colheita').length, tone: 'amber', icon: 'harvest' }),
    statCard({ label: 'Colhidos', value: plantings.filter((item) => item.status === 'colhido').length, tone: 'teal', icon: 'shield' }),
  ].join('');
}

function buttons(kind, id, extra = '', { allowDelete = true } = {}) {
  return `<td class="agro-actions">
    <button class="btn-ghost agro-mini" type="button" data-edit="${kind}" data-id="${escapeHtml(id)}">Editar</button>
    ${extra}
    ${
      allowDelete
        ? `<button class="btn-ghost agro-mini" type="button" data-delete="${kind}" data-id="${escapeHtml(id)}">Excluir</button>`
        : ''
    }
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
        const planting = (data.plantings || []).find((entry) => entry.id === item.plantingId);
        const sigla = productSigla(data.catalog, planting?.productId || '', item.productName);
        const area = item.plotName || planting?.plotName || '—';
        const price = avgSalePrice(data, item.productName, planting?.productId || '');
        const revenue = price > 0 ? Number(item.quantity || 0) * price : null;
        const search = `${item.propertyName} ${area} ${sigla} ${item.productName}`.toLowerCase();
        const remaining = planting ? planting.harvestedQty - planting.deliveredQty : 0;
        const deliver =
          remaining > 0.0001
            ? `<button class="btn-ghost agro-mini" type="button" data-go="entrega" data-planting="${escapeHtml(item.plantingId)}">Entregar</button>`
            : '';
        const close =
          item.plantingStatus !== 'colhido'
            ? `<button class="btn-ghost agro-mini" type="button" data-close-planting="${escapeHtml(item.plantingId)}">Encerrar plantio</button>`
            : '';
        return `<tr data-search="${escapeHtml(search)}">
          <td>${dateBr(item.harvestedOn)}</td>
          <td>${escapeHtml(sigla)}<span class="agro-sub">${escapeHtml(item.productName)}</span></td>
          <td>${qty(item.quantity, item.unit)}</td>
          <td>${escapeHtml(area)}<span class="agro-sub">${escapeHtml(item.propertyName || '')}</span></td>
          <td>${money(revenue)}</td>
          <td>${escapeHtml(item.propertyName)}<span class="agro-sub">${statusPill(item.plantingStatus)}</span></td>
          ${buttons('colheita', item.id, `${deliver}${close}`)}
        </tr>`;
      })
      .join('');
    return table(
      ['Data', 'Produto', 'Quantidade', 'Área', 'Receita área', 'Propriedade'],
      rows,
      'Nenhuma colheita registrada.',
    );
  }
  if (tab === 'entrega') {
    const rows = (data.deliveries || [])
      .map((item) => {
        const planting = (data.plantings || []).find((entry) => entry.id === item.plantingId);
        const sigla = productSigla(data.catalog, planting?.productId || '', item.productName);
        const search = `${item.propertyName} ${item.partnerName} ${sigla} ${item.productName} ${item.document} ${item.odooOrderRef}`.toLowerCase();
        const pending = !item.odooOrderId;
        const pedido = item.odooOrderRef
          ? `Pedido ${item.odooOrderRef}`
          : item.odooOrderId
            ? `Pedido #${item.odooOrderId}`
            : 'Pendente pedido';
        const select = pending
          ? `<input type="checkbox" data-group-delivery value="${escapeHtml(item.id)}" data-partner="${escapeHtml(item.partnerId || '')}" aria-label="Selecionar entrega">`
          : '';
        return `<tr data-search="${escapeHtml(search)}">
          <td>${select}</td>
          <td>${dateBr(item.deliveredOn)}</td>
          <td>${escapeHtml(sigla)}<span class="agro-sub">${escapeHtml(item.productName)}</span></td>
          <td>${qty(item.quantity, item.unit)}</td>
          <td>${escapeHtml(item.partnerName)}<span class="agro-sub">Local de entrega</span></td>
          <td>${escapeHtml(item.propertyName)}</td>
          <td>${money(item.unitPrice)}</td>
          <td>${money(item.totalValue)}</td>
          <td>${escapeHtml(item.document || '—')}<span class="agro-sub">${escapeHtml(pedido)}</span></td>
          ${buttons('entrega', item.id, '', { allowDelete: pending })}
        </tr>`;
      })
      .join('');
    return table(
      ['', 'Data', 'Produto', 'Quantidade', 'Local', 'Origem', 'Unitário', 'Total', 'Documento / Pedido'],
      rows,
      'Nenhuma entrega registrada.',
    );
  }
  if (tab === 'custos') {
    const rows = (data.costs || [])
      .map((item) => {
        const search = `${item.propertyName} ${item.plotName} ${item.name}`.toLowerCase();
        return `<tr data-search="${escapeHtml(search)}">
          <td>${dateBr(item.costOn)}</td>
          <td>${escapeHtml(item.name)}</td>
          <td>${qty(item.quantity)}</td>
          <td>${escapeHtml(item.plotName || '—')}<span class="agro-sub">${escapeHtml(item.propertyName || '')}</span></td>
          <td>${money(item.totalValue)}</td>
          ${buttons('custos', item.id)}
        </tr>`;
      })
      .join('');
    return table(['Data', 'Nome', 'Quantidade', 'Área', 'Valor'], rows, 'Nenhum custo registrado.');
  }
  const rows = (data.plantings || [])
    .map((item) => {
      const sigla = productSigla(data.catalog, item.productId, item.productName);
      const search = `${item.propertyName} ${item.producerName} ${item.plotName} ${sigla} ${item.productName}`.toLowerCase();
      const harvest =
        item.status === 'colhido'
          ? ''
          : `<button class="btn-ghost agro-mini" type="button" data-go="colheita" data-planting="${escapeHtml(item.id)}">Colher</button>`;
      const close =
        item.status === 'em_colheita'
          ? `<button class="btn-ghost agro-mini" type="button" data-close-planting="${escapeHtml(item.id)}">Encerrar plantio</button>`
          : '';
      return `<tr data-search="${escapeHtml(search)}">
        <td>${dateBr(item.plantedOn)}</td>
        <td>${escapeHtml(sigla)}<span class="agro-sub">${escapeHtml(item.productName)} · ${escapeHtml(item.unit || '')}</span></td>
        <td>${qty(item.forecastQty, item.unit)}</td>
        <td>${escapeHtml(item.propertyName)}</td>
        <td>${escapeHtml(item.producerName || '—')}</td>
        <td>${escapeHtml(item.plotName || '—')}</td>
        <td>${qty(item.areaPlanned, 'ha')}</td>
        <td>${qty(item.harvestedQty, item.unit)}</td>
        <td>${statusPill(item.status)}</td>
        ${buttons('plantio', item.id, `${harvest}${close}`)}
      </tr>`;
    })
    .join('');
  return table(
    ['Data', 'Produto', 'Quantidade', 'Propriedade', 'Fornecedor', 'Talhão', 'Área', 'Colhido', 'Situação'],
    rows,
    'Nenhum plantio nesta empresa.',
  );
}

export function shell(tab) {
  const meta = tabMeta(tab);
  if (tab === 'configuracoes') {
    return `
    <div class="view-pane forms-pane agro-pane">
      <div class="forms-toolbar">
        <header class="page-head">
          <h1>${escapeHtml(meta.label)}</h1>
          <p class="muted">${escapeHtml(meta.description)}. Os registros seguem a empresa ativa do Odoo.</p>
        </header>
        <div class="row forms-top-actions">
          <button class="btn-ghost" type="button" data-settings-new="property">Nova propriedade</button>
          <button class="btn" type="button" data-settings-new="producer">Novo produtor</button>
        </div>
      </div>
      <div id="agro-body"></div>
    </div>`;
  }
  if (tab === 'dashboard') {
    return `
    <div class="view-pane forms-pane agro-pane">
      <div class="forms-toolbar">
        <header class="page-head">
          <h1>${escapeHtml(meta.label)}</h1>
          <p class="muted">${escapeHtml(meta.description)}.</p>
        </header>
        <div class="row forms-top-actions" id="agro-dash-actions"></div>
      </div>
      <div id="agro-body"></div>
    </div>`;
  }
  const presets = tab === 'custos' ? '' : `<button class="btn-ghost" type="button" data-presets>Padrões</button>`;
  return `
    <div class="view-pane forms-pane agro-pane">
      <div class="forms-toolbar">
        <header class="page-head">
          <h1>${escapeHtml(meta.label)}</h1>
          <p class="muted">${escapeHtml(meta.description)}. Os registros seguem a empresa ativa do Odoo.</p>
        </header>
        <div class="row forms-top-actions">
          ${presets}
          <button class="btn" type="button" data-new="${escapeHtml(tab)}">Novo</button>
        </div>
      </div>
      <div id="agro-body"></div>
    </div>`;
}

function emptyLabel(tab) {
  if (tab === 'colheita') return 'Nenhuma colheita registrada.';
  if (tab === 'entrega') return 'Nenhuma entrega registrada.';
  if (tab === 'custos') return 'Nenhum custo registrado.';
  return 'Nenhum plantio nesta empresa.';
}

export function bodyHtml(tab, data) {
  const rows =
    tab === 'colheita'
      ? data.harvests
      : tab === 'entrega'
        ? data.deliveries
        : tab === 'custos'
          ? data.costs
          : data.plantings;
  const groupBar =
    tab === 'entrega'
      ? `<div class="row agro-group-bar">
          <button class="btn" type="button" data-group-sale disabled>Gerar pedido Odoo</button>
          <span class="muted" data-group-hint>Selecione entregas do mesmo local (ainda sem pedido).</span>
        </div>`
      : '';
  return `
    <div class="stat-row stat-row--3">${stats(tab, data)}</div>
    <section class="card data-results agro-panel">
      <div class="forms-filters">
        <label class="forms-filter-search">Busca
          <input data-filter placeholder="Propriedade, produto, talhão, custo ou comprador" />
        </label>
        ${groupBar}
      </div>
      ${rows?.length ? listHtml(tab, data) : `<p class="muted">${escapeHtml(emptyLabel(tab))}</p>`}
    </section>`;
}
