import { api } from '../api.js';
import { getActiveCompanyId, loadCompanies } from '../company-switcher.js';
import { escapeHtml, statCard } from '../ui.js';

const MONTHS = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

const PALETTE = [
  '#f88828',
  '#1aa897',
  '#2b5aa8',
  '#2ecc71',
  '#7c5cd6',
  '#e07b20',
  '#1a4f9c',
  '#e5487d',
  '#f5b400',
  '#2a2a2e',
  '#14b8a6',
  '#909090',
];

/** Cor estável por sigla, para o mesmo tipo não mudar de lugar no ranking. */
const BAG_COLORS = {
  PAP: '#e2a100',
  PTB: '#3b82f6',
  CRI: '#14b8a6',
  PMI: '#f59e0b',
  LEI: '#6366f1',
  SCC: '#ec4899',
  PP: '#22c55e',
  SCP: '#64748b',
  FER: '#ea580c',
  PEC: '#f97316',
  PPB: '#84cc16',
  PPP: '#7c3aed',
  PTO: '#0d9488',
};

/** Fluxo do RSU: recebimento → separação → prensagem → entrega → venda. */
const SECTIONS = [
  {
    id: 'receipts',
    title: 'Recebimentos',
    chartTitle: 'KG recebidos por dia',
    totalLabel: 'Total recebido',
    statLabel: 'Recebido no período',
    tone: 'orange',
    color: '#f88828',
    icon: 'truck',
    href: '#/forms/compras',
  },
  {
    id: 'separation',
    title: 'Separação',
    chartTitle: 'Bags separadas no período, por tipo',
    totalLabel: 'Total separado',
    statLabel: 'Bags separadas',
    tone: 'teal',
    color: '#1aa897',
    icon: 'box',
    href: '#/forms/inventario',
    stacked: true,
  },
  {
    id: 'pressing',
    title: 'Prensagem',
    chartTitle: 'Fardos produzidos por dia (kg), por produto',
    totalLabel: 'Total prensado',
    statLabel: 'Fardos prensados',
    tone: 'violet',
    color: '#7c5cd6',
    icon: 'factory',
    href: '#/forms/fabricacao',
    stacked: true,
  },
  {
    id: 'deliveries',
    title: 'Entrega',
    chartTitle: 'Fardos entregues por dia (kg), por produto',
    totalLabel: 'Total entregue',
    statLabel: 'Fardos entregues',
    tone: 'amber',
    color: '#e07b20',
    icon: 'cart',
    href: '#/forms/vendas',
    stacked: true,
  },
  {
    id: 'sales',
    title: 'Venda',
    chartTitle: 'Valor vendido por dia',
    totalLabel: 'Total vendido',
    statLabel: 'Vendido no período',
    tone: 'blue',
    color: '#2b5aa8',
    icon: 'money',
    href: '#/forms/vendas',
    wide: true,
  },
];

const AGRO_CHARTS = [
  {
    id: 'planting',
    key: 'plantingByProduct',
    title: 'Plantio',
    chartTitle: 'Produção estimada plantada no período',
    totalKey: 'estimatedQty',
    totalLabel: 'Estimado no período',
    tone: 'green',
    color: '#22c55e',
    unit: '',
  },
  {
    id: 'harvest',
    key: 'harvestByProduct',
    title: 'Colheita',
    chartTitle: 'Quantidade colhida no período',
    totalKey: 'harvestedQty',
    totalLabel: 'Colhido no período',
    tone: 'amber',
    color: '#e07b20',
    unit: '',
  },
  {
    id: 'agro-delivery',
    key: 'deliveryByProduct',
    title: 'Entrega agro',
    chartTitle: 'Produção entregue no período',
    totalKey: 'deliveredQty',
    totalLabel: 'Entregue no período',
    tone: 'teal',
    color: '#1aa897',
    unit: '',
  },
  {
    id: 'agro-costs',
    key: 'costsByArea',
    title: 'Custos agro',
    chartTitle: 'Custos de produção por área',
    totalKey: 'costs',
    totalLabel: 'Custos no período',
    tone: 'navy',
    color: '#2b5aa8',
    unit: 'R$',
  },
];

let chartReady = null;
const chartInstances = new Map();

async function loadChartJs() {
  if (chartReady) return chartReady;
  chartReady = (async () => {
    const mod = await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm');
    const { Chart, BarController, BarElement, CategoryScale, LinearScale, Legend, Tooltip } = mod;
    Chart.register(BarController, BarElement, CategoryScale, LinearScale, Legend, Tooltip);
    return { Chart };
  })();
  return chartReady;
}

function formatQty(value) {
  return Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2,
  });
}

/** Valor com a unidade da seção: R$, “12 bags”, “1.200 kg”. */
function formatValue(unit, value) {
  if (unit === 'R$') return formatMoney(value);
  const qty = formatQty(value);
  if (unit === 'Bag') return `${qty} ${Number(value) === 1 ? 'bag' : 'bags'}`;
  if (unit === 'Fardo') return `${qty} ${Number(value) === 1 ? 'fardo' : 'fardos'}`;
  return unit ? `${qty} ${unit}` : qty;
}

function destroyCharts() {
  for (const chart of chartInstances.values()) {
    try {
      chart.destroy();
    } catch {
      /* ignore */
    }
  }
  chartInstances.clear();
}

function yearOptions(selected) {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now; y >= now - 6; y -= 1) years.push(y);
  if (!years.includes(selected)) years.unshift(selected);
  return years
    .map((y) => `<option value="${y}"${y === selected ? ' selected' : ''}>${y}</option>`)
    .join('');
}

function monthOptions(selected) {
  return MONTHS.map(
    (label, index) =>
      `<option value="${index + 1}"${index + 1 === selected ? ' selected' : ''}>${label}</option>`,
  ).join('');
}

export function renderPeriodPicker(period) {
  const month = period?.month || new Date().getMonth() + 1;
  const year = period?.year || new Date().getFullYear();
  return `
    <div class="hub-period" role="group" aria-label="Período dos indicadores">
      <span class="hub-period-label">Período</span>
      <select id="hub-dash-month" aria-label="Mês">${monthOptions(month)}</select>
      <select id="hub-dash-year" aria-label="Ano">${yearOptions(year)}</select>
    </div>`;
}

function statsCards(data = null) {
  const loading = !data;
  return SECTIONS.map((def) => {
    const section = data?.[def.id] || {};
    const value = formatValue(section.unit, section.total);
    return statCard({ label: def.statLabel, value, tone: def.tone, icon: def.icon, href: def.href, title: value, loading });
  }).join('');
}

export function renderDashboardStats() {
  return `<section class="stat-row hub-stats" id="hub-stats" aria-label="Resumo do período">${statsCards()}</section>`;
}

export function renderDashboardShell() {
  return `
    <section class="hub-dashboard" id="hub-dashboard" aria-label="Indicadores">
      <div class="hub-dashboard-body" id="hub-dashboard-body">
        <p class="card muted hub-dashboard-loading">Carregando indicadores…</p>
      </div>
    </section>`;
}

function separationRows(section) {
  const totals = new Map();
  for (const day of section?.dailyStacked || []) {
    for (const [product, qty] of Object.entries(day.byProduct || {})) {
      totals.set(product, (totals.get(product) || 0) + Number(qty || 0));
    }
  }
  return [...totals.entries()]
    .map(([product, qty]) => ({ product, qty }))
    .filter((row) => row.qty > 0)
    .sort((a, b) => b.qty - a.qty || a.product.localeCompare(b.product, 'pt-BR'));
}

function bagLabel(product) {
  const [code, ...rest] = String(product || '').split(' ');
  const name = rest.join(' ').trim();
  return name ? `${code} · ${name}` : code;
}

function bagColor(product, index) {
  const code = String(product || '').split(' ')[0].toUpperCase();
  return BAG_COLORS[code] || PALETTE[index % PALETTE.length];
}

function inkOn(hex) {
  const value = String(hex || '').replace('#', '');
  if (value.length !== 6) return '#ffffff';
  const n = Number.parseInt(value, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.64 ? '#1a1a1c' : '#ffffff';
}

function separationChartTitle(section) {
  const days = (section?.dailyStacked || []).filter((day) => day.total > 0);
  if (days.length === 1) return `Bags do dia ${days[0].label}, por tipo`;
  return 'Bags separadas no período, por tipo';
}

function sectionHtml(def, section) {
  const title = def.id === 'separation' ? separationChartTitle(section) : def.chartTitle;
  return `
    <article class="card hub-dash-section tone-${def.tone}${def.wide ? ' hub-dash-wide' : ''}" data-section="${escapeHtml(def.id)}">
      <div class="hub-dash-section-head">
        <h3>${escapeHtml(def.title)}</h3>
        <p class="hub-dash-total">${escapeHtml(def.totalLabel)} <strong>${escapeHtml(formatValue(section?.unit, section?.total))}</strong></p>
      </div>
      <p class="hub-dash-chart-title">${escapeHtml(title)}</p>
      <div class="hub-dash-canvas-wrap">
        <canvas id="chart-${escapeHtml(def.id)}"></canvas>
      </div>
    </article>`;
}

function stockMessageRow(text) {
  return `<tr><td colspan="3" class="hub-stock-empty">${escapeHtml(text)}</td></tr>`;
}

function stockRowsHtml(items) {
  if (!items.length) return stockMessageRow('Nenhum produto com saldo em estoque.');
  return items
    .map(
      (item) => `
        <tr data-stock-name="${escapeHtml(String(item.product || '').toLowerCase())}">
          <td>${escapeHtml(item.product)}</td>
          <td class="muted">${escapeHtml(item.category || '—')}</td>
          <td class="hub-stock-qty${item.qty < 0 ? ' is-negative' : ''}">${escapeHtml(formatQty(item.qty))} <span>${escapeHtml(item.uom || '')}</span></td>
        </tr>`,
    )
    .join('');
}

function stockFamily(product) {
  const name = String(product || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  if (/\bfardos?\b/.test(name)) return 'fardo';
  if (/\bbags?\b/.test(name)) return 'bag';
  return '';
}

function stockTotals(items) {
  let bags = 0;
  let fardos = 0;
  for (const item of items) {
    const qty = Number(item.qty) || 0;
    const family = stockFamily(item.product);
    if (family === 'bag') bags += qty;
    if (family === 'fardo') fardos += qty;
  }
  return { bags, fardos };
}

function paintStockTotals(root, items) {
  const totals = stockTotals(items);
  const bags = root.querySelector('#hub-stock-bags');
  const fardos = root.querySelector('#hub-stock-fardos');
  if (bags) bags.textContent = formatValue('Bag', totals.bags);
  if (fardos) fardos.textContent = formatValue('Fardo', totals.fardos);
}

function stockHtml() {
  return `
    <article class="card hub-dash-section hub-dash-wide hub-stock tone-green" data-section="stock">
      <div class="hub-dash-section-head">
        <h3>Estoque atual</h3>
        <input class="hub-stock-search" id="hub-stock-search" type="search" placeholder="Buscar produto…" aria-label="Buscar produto no estoque" disabled />
      </div>
      <p class="hub-dash-chart-title" id="hub-stock-count">Consultando o Odoo…</p>
      <div class="hub-stock-totals" id="hub-stock-totals">
        <div>
          <span>Bags</span>
          <strong id="hub-stock-bags">—</strong>
        </div>
        <div>
          <span>Fardos</span>
          <strong id="hub-stock-fardos">—</strong>
        </div>
      </div>
      <div class="hub-stock-wrap">
        <table class="hub-stock-table">
          <thead><tr><th>Produto</th><th>Categoria</th><th>Quantidade</th></tr></thead>
          <tbody id="hub-stock-rows">${stockMessageRow('Carregando estoque…')}</tbody>
        </table>
      </div>
    </article>`;
}

function stockCountText(total, shown, source) {
  if (shown !== total) return `${shown} de ${total} produto(s) com saldo`;
  const origin = source === 'odoo' ? 'saldo atual no Odoo' : 'última sincronização com o Odoo';
  return `${total} produto(s) com saldo · ${origin}`;
}

async function loadStock(body, scope = 'hub') {
  const rows = body.querySelector('#hub-stock-rows');
  const count = body.querySelector('#hub-stock-count');
  const input = body.querySelector('#hub-stock-search');
  let data;
  try {
    const params = new URLSearchParams();
    if (scope === 'entity') {
      const companyId = getActiveCompanyId();
      if (companyId) params.set('companyId', companyId);
    }
    const query = params.toString();
    data = await api(`/api/hub/stock${query ? `?${query}` : ''}`);
  } catch (error) {
    if (rows) rows.innerHTML = stockMessageRow(error.message || 'Falha ao carregar estoque');
    if (count) count.textContent = 'Estoque indisponível';
    return;
  }
  if (!rows?.isConnected) return;
  const items = data.items || [];
  rows.innerHTML = stockRowsHtml(items);
  paintStockTotals(body, items);
  if (count) count.textContent = stockCountText(items.length, items.length, data.source);
  if (!input) return;
  input.disabled = false;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    const visible = [];
    items.forEach((item, index) => {
      const row = rows.querySelectorAll('tr[data-stock-name]')[index];
      const match = !q || String(item.product || '').toLowerCase().includes(q);
      if (row) row.hidden = !match;
      if (match) {
        shown += 1;
        visible.push(item);
      }
    });
    paintStockTotals(body, visible);
    if (count) count.textContent = stockCountText(items.length, shown, data.source);
  });
}

function agroSummaryHtml(agro) {
  if (!agro?.summary) return '';
  const s = agro.summary;
  const cards = [
    { label: 'Área plantada', value: `${formatQty(s.plantedAreaHa)} ha` },
    { label: 'Colheita agro', value: formatQty(s.harvestedQty) },
    { label: 'Entrega agro', value: formatQty(s.deliveredQty) },
    { label: 'Custos agro', value: formatMoney(s.costs) },
  ];
  return `
    <div class="hub-agro-summary" aria-label="Resumo agro">
      ${cards
        .map(
          (card) => `
        <div class="hub-agro-summary-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
        </div>`,
        )
        .join('')}
    </div>`;
}

function agroSectionHtml(def, agro) {
  const bars = agro?.[def.key] || [];
  const total = agro?.summary?.[def.totalKey] ?? bars.reduce((sum, item) => sum + Number(item.value || 0), 0);
  return `
    <article class="card hub-dash-section tone-${def.tone}" data-section="agro-${escapeHtml(def.id)}">
      <div class="hub-dash-section-head">
        <h3>${escapeHtml(def.title)}</h3>
        <p class="hub-dash-total">${escapeHtml(def.totalLabel)} <strong>${escapeHtml(formatValue(def.unit, total))}</strong></p>
      </div>
      <p class="hub-dash-chart-title">${escapeHtml(def.chartTitle)}</p>
      <div class="hub-dash-canvas-wrap hub-agro-canvas">
        <canvas id="chart-agro-${escapeHtml(def.id)}"></canvas>
      </div>
    </article>`;
}

function agroBlockHtml(agro) {
  if (!agro) return '';
  const hasData =
    Number(agro.summary?.harvestedQty || 0) > 0 ||
    Number(agro.summary?.deliveredQty || 0) > 0 ||
    Number(agro.summary?.estimatedQty || 0) > 0 ||
    Number(agro.summary?.costs || 0) > 0 ||
    Number(agro.summary?.plantedAreaHa || 0) > 0 ||
    (agro.plantingByProduct || []).length > 0;
  if (!hasData) {
    return `
      <article class="card hub-dash-section hub-dash-wide tone-green" data-section="agro">
        <div class="hub-dash-section-head">
          <h3>Agro</h3>
        </div>
        <p class="muted hub-agro-empty">Sem lançamentos agro neste período.</p>
      </article>`;
  }
  return `
    <article class="card hub-dash-section hub-dash-wide tone-green hub-agro-block" data-section="agro">
      <div class="hub-dash-section-head">
        <h3>Agro</h3>
        <p class="hub-dash-total">Visão geral <strong>${escapeHtml(agro.scope === 'all' ? 'todas as empresas' : 'empresa ativa')}</strong></p>
      </div>
      ${agroSummaryHtml(agro)}
      <div class="hub-agro-grid">
        ${AGRO_CHARTS.map((def) => agroSectionHtml(def, agro)).join('')}
      </div>
    </article>`;
}

function paintBody(data, scope = 'hub') {
  const stats = document.querySelector('#hub-stats');
  if (stats) stats.innerHTML = statsCards(data);
  const body = document.querySelector('#hub-dashboard-body');
  if (!body) return;
  body.innerHTML =
    SECTIONS.map((def) => sectionHtml(def, data[def.id])).join('') +
    agroBlockHtml(data.agro) +
    stockHtml();
  loadStock(body, scope).catch(() => {});
}

function chartDefaults(Chart) {
  Chart.defaults.color = '#6b6b70';
  Chart.defaults.borderColor = 'rgba(26, 26, 28, 0.06)';
  Chart.defaults.font.family = 'Outfit, "Segoe UI", sans-serif';
  Chart.defaults.plugins.tooltip.backgroundColor = '#000008';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 10;
}

function datasetsFor(def, section) {
  const products = def.stacked ? section.products || [] : [];
  if (!products.length) {
    return [
      {
        label: def.title,
        data: (section.daily || []).map((d) => d.value),
        backgroundColor: def.color,
        borderRadius: 4,
      },
    ];
  }
  return products.map((product, index) => ({
    label: product,
    data: (section.dailyStacked || []).map((day) => day.byProduct?.[product] || 0),
    backgroundColor: PALETTE[index % PALETTE.length],
    borderRadius: 3,
  }));
}

const bagValueLabels = {
  id: 'bagValueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const dataset = chart.data.datasets[0];
    if (!dataset) return;
    ctx.save();
    ctx.font = '600 12px Outfit, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    const colors = Array.isArray(dataset.backgroundColor) ? dataset.backgroundColor : [];
    chart.getDatasetMeta(0).data.forEach((bar, index) => {
      const text = formatQty(dataset.data[index]);
      const width = bar.x - bar.base;
      const inside = width > ctx.measureText(text).width + 14;
      ctx.fillStyle = inside ? inkOn(colors[index]) : '#1a1a1c';
      ctx.textAlign = inside ? 'right' : 'left';
      ctx.fillText(text, inside ? bar.x - 8 : bar.x + 8, bar.y);
    });
    ctx.restore();
  },
};

function makeSeparationBar(Chart, canvas, section) {
  if (!canvas) return;
  const existing = chartInstances.get(canvas.id);
  if (existing) existing.destroy();
  const rows = separationRows(section);
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((row) => bagLabel(row.product)),
      datasets: [
        {
          label: 'Bags',
          data: rows.map((row) => row.qty),
          backgroundColor: rows.map((row, index) => bagColor(row.product, index)),
          borderRadius: 6,
          barThickness: 18,
        },
      ],
    },
    plugins: [bagValueLabels],
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 28 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              return formatValue('Bag', ctx.parsed.x);
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { display: false },
          ticks: { callback: (value) => formatQty(value) },
        },
        y: {
          grid: { display: false },
          ticks: { autoSkip: false, font: { size: 11 }, color: '#1a1a1c' },
        },
      },
    },
  });
  chartInstances.set(canvas.id, chart);
}

function makeBar(Chart, canvas, def, section) {
  if (!canvas) return;
  if (def.id === 'separation' && separationRows(section).length) {
    makeSeparationBar(Chart, canvas, section);
    return;
  }
  const existing = chartInstances.get(canvas.id);
  if (existing) existing.destroy();
  const datasets = datasetsFor(def, section);
  const stacked = Boolean(def.stacked && section.products?.length);
  const unit = section.unit || '';
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels: (section.daily || []).map((d) => d.label), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: stacked, position: 'bottom', labels: { boxWidth: 10 } },
        tooltip: {
          callbacks: {
            title(items) {
              return items[0] ? `Dia ${items[0].label}` : '';
            },
            label(ctx) {
              return `${ctx.dataset.label}: ${formatValue(unit, ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: { stacked, grid: { display: false } },
        y: {
          stacked,
          beginAtZero: true,
          ticks: {
            callback(value) {
              return unit === 'R$' ? formatMoney(value) : formatQty(value);
            },
          },
        },
      },
    },
  });
  chartInstances.set(canvas.id, chart);
}

function alignChartHeights(data) {
  const rows = separationRows(data?.separation);
  const height = Math.max(220, rows.length * 32 + 12);
  document.querySelectorAll('.hub-dash-canvas-wrap').forEach((wrap) => {
    wrap.style.height = `${height}px`;
  });
}

function makeAgroBar(Chart, canvas, def, bars) {
  if (!canvas) return;
  const existing = chartInstances.get(canvas.id);
  if (existing) existing.destroy();
  const rows = Array.isArray(bars) ? bars : [];
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((row) => row.label),
      datasets: [
        {
          label: def.title,
          data: rows.map((row) => Number(row.value || 0)),
          backgroundColor: def.color,
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: rows.length > 6 ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const value = ctx.parsed.y == null ? ctx.parsed.x : ctx.parsed.y;
              return formatValue(def.unit, value);
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { display: false },
          ticks: {
            callback(value) {
              return def.unit === 'R$' ? formatMoney(value) : formatQty(value);
            },
          },
        },
        y: {
          beginAtZero: true,
          grid: { display: false },
          ticks: {
            callback(value) {
              if (rows.length > 6) return value;
              return def.unit === 'R$' ? formatMoney(value) : formatQty(value);
            },
          },
        },
      },
    },
  });
  chartInstances.set(canvas.id, chart);
}

async function paintCharts(data) {
  const { Chart } = await loadChartJs();
  chartDefaults(Chart);
  destroyCharts();
  alignChartHeights(data);
  for (const def of SECTIONS) {
    makeBar(Chart, document.querySelector(`#chart-${def.id}`), def, data[def.id] || {});
  }
  if (data.agro) {
    for (const def of AGRO_CHARTS) {
      makeAgroBar(Chart, document.querySelector(`#chart-agro-${def.id}`), def, data.agro[def.key] || []);
    }
  }
}

let companyChangeHandler = null;

/**
 * @param {HTMLElement} root
 * @param {{ scope?: 'hub' | 'entity' }} [options]
 * scope=entity: dashboard do módulo RSU, sempre filtrado pela empresa ativa.
 * scope=hub: consolidado do WEB (Reciclarenda = todas as empresas).
 */
export async function mountHubDashboard(root, options = {}) {
  const monthEl = root.querySelector('#hub-dash-month');
  const yearEl = root.querySelector('#hub-dash-year');
  if (!monthEl || !yearEl) return;
  const scope = options.scope === 'entity' ? 'entity' : 'hub';

  const load = async () => {
    const month = Number(monthEl.value);
    const year = Number(yearEl.value);
    const body = root.querySelector('#hub-dashboard-body');
    if (body) body.innerHTML = '<p class="card muted hub-dashboard-loading">Carregando indicadores…</p>';
    const stats = root.querySelector('#hub-stats');
    if (stats) stats.innerHTML = statsCards();
    destroyCharts();
    try {
      const params = new URLSearchParams({ month: String(month), year: String(year) });
      if (scope === 'entity') {
        if (!getActiveCompanyId()) await loadCompanies(false).catch(() => null);
        const companyId = getActiveCompanyId();
        if (companyId) params.set('companyId', companyId);
      }
      const data = await api(`/api/hub/dashboard?${params}`);
      paintBody(data, scope);
      try {
        await paintCharts(data);
      } catch (chartError) {
        console.error('dashboard charts:', chartError);
        const tip = document.createElement('p');
        tip.className = 'card muted hub-dashboard-loading';
        tip.textContent = `Gráficos indisponíveis: ${chartError.message || 'erro ao carregar Chart.js'}`;
        body?.appendChild(tip);
      }
    } catch (error) {
      if (body) {
        body.innerHTML = `<p class="card muted hub-dashboard-loading">${escapeHtml(error.message || 'Falha ao carregar dashboard')}</p>`;
      }
    }
  };

  monthEl.addEventListener('change', () => {
    load().catch(() => {});
  });
  yearEl.addEventListener('change', () => {
    load().catch(() => {});
  });

  if (companyChangeHandler) {
    window.removeEventListener('vertice:company-changed', companyChangeHandler);
  }
  companyChangeHandler = () => {
    load().catch(() => {});
  };
  window.addEventListener('vertice:company-changed', companyChangeHandler);

  await load();
}

export function stopHubDashboard() {
  destroyCharts();
  if (companyChangeHandler) {
    window.removeEventListener('vertice:company-changed', companyChangeHandler);
    companyChangeHandler = null;
  }
}
