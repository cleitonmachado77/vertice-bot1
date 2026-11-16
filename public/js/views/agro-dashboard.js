import { api } from '../api.js';
import { escapeHtml, statCard } from '../ui.js';

const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
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

function periodPicker(period) {
  const month = period?.month || new Date().getMonth() + 1;
  const year = period?.year || new Date().getFullYear();
  return `
    <div class="hub-period agro-period" role="group" aria-label="Período">
      <span class="hub-period-label">Período</span>
      <select id="agro-dash-month" aria-label="Mês">${monthOptions(month)}</select>
      <select id="agro-dash-year" aria-label="Ano">${yearOptions(year)}</select>
    </div>`;
}

function productFilter(products, selected) {
  return `
    <label class="agro-dash-product">Produto
      <select id="agro-dash-product" aria-label="Filtrar estimativa por produto">
        <option value="">Todos</option>
        ${(products || [])
          .map(
            (item) =>
              `<option value="${escapeHtml(item.label)}"${item.label === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`,
          )
          .join('')}
      </select>
    </label>`;
}

function sectionCard(id, title, hint = '') {
  return `
    <section class="card agro-dash-card" data-chart="${escapeHtml(id)}">
      <header class="agro-dash-card-head">
        <h3>${escapeHtml(title)}</h3>
        ${hint ? `<p class="muted">${escapeHtml(hint)}</p>` : ''}
      </header>
      <div class="agro-dash-chart-wrap">
        <canvas id="agro-chart-${escapeHtml(id)}" height="180"></canvas>
      </div>
    </section>`;
}

function summaryCards(summary) {
  return [
    statCard({ label: 'Plantios no período', value: summary?.plantings ?? '—', tone: 'green', icon: 'sprout' }),
    statCard({ label: 'Colhido', value: formatQty(summary?.harvestedQty), tone: 'amber', icon: 'harvest' }),
    statCard({ label: 'Entregue', value: formatQty(summary?.deliveredQty), tone: 'orange', icon: 'truck' }),
    statCard({ label: 'Custos', value: formatMoney(summary?.costs), tone: 'blue', icon: 'money' }),
    statCard({ label: 'Margem áreas', value: formatMoney(summary?.margin), tone: 'teal', icon: 'shield' }),
  ].join('');
}

function makeBar(Chart, canvas, labels, values, label, color = '#2e8b57') {
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label,
          data: values,
          backgroundColor: color,
          borderRadius: 8,
          maxBarThickness: 42,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
  chartInstances.set(canvas.id, chart);
}

function makeGrouped(Chart, canvas, rows) {
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((item) => item.label),
      datasets: [
        {
          label: 'Receita',
          data: rows.map((item) => item.revenue),
          backgroundColor: '#2e8b57',
          borderRadius: 8,
          maxBarThickness: 28,
        },
        {
          label: 'Despesas',
          data: rows.map((item) => item.expense),
          backgroundColor: '#c45c26',
          borderRadius: 8,
          maxBarThickness: 28,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true },
      },
    },
  });
  chartInstances.set(canvas.id, chart);
}

function filterForecast(data, product) {
  const bars = data?.forecast?.byProduct || [];
  if (!product) return bars;
  return bars.filter((item) => item.label === product);
}

async function paintCharts(data, productFilterValue) {
  const { Chart } = await loadChartJs();
  Chart.defaults.color = '#6b6b70';
  Chart.defaults.borderColor = 'rgba(26, 26, 28, 0.06)';
  Chart.defaults.font.family = 'Outfit, "Segoe UI", sans-serif';
  destroyCharts();

  const forecast = filterForecast(data, productFilterValue);
  const pairs = [
    ['forecast', forecast, 'Estimativa', '#2e8b57'],
    ['planting', data.plantingByProduct || [], 'Plantio (ha)', '#3d8b6e'],
    ['harvest', data.harvestByProduct || [], 'Colheita', '#d4a017'],
    ['delivery', data.deliveryByProduct || [], 'Entrega', '#c45c26'],
    ['sales', data.salesByProduct || [], 'Venda (R$)', '#2b5aa8'],
    ['stock', data.stockByProduct || [], 'Estoque', '#1f7a5c'],
    ['costs', data.costsByArea || [], 'Custos por área', '#8b4513'],
  ];
  for (const [id, rows, label, color] of pairs) {
    const canvas = document.getElementById(`agro-chart-${id}`);
    if (!canvas) continue;
    makeBar(
      Chart,
      canvas,
      rows.map((item) => item.label),
      rows.map((item) => item.value),
      label,
      color,
    );
  }
  const revenueCanvas = document.getElementById('agro-chart-revenue');
  if (revenueCanvas) makeGrouped(Chart, revenueCanvas, data.revenueExpenseByArea || []);
}

function paint(root, data, productFilterValue = '') {
  const actions = root.querySelector('#agro-dash-actions') || root.querySelector('.forms-top-actions');
  if (actions) {
    actions.innerHTML = `${productFilter(data.products, productFilterValue)}${periodPicker(data.period)}`;
  }
  const body = root.querySelector('#agro-body');
  if (!body) return;
  body.innerHTML = `
    <div class="stat-row stat-row--5 agro-dash-stats">${summaryCards(data.summary)}</div>
    <div class="agro-dash-grid">
      ${sectionCard('forecast', 'Estimativa de produção', 'Quantidades na data estimada')}
      ${sectionCard('planting', 'Plantio', 'Área (ha) por produto')}
      ${sectionCard('harvest', 'Colheita', 'Unidade por produto')}
      ${sectionCard('delivery', 'Entrega', 'Unidade por produto')}
      ${sectionCard('sales', 'Venda', 'R$ por produto')}
      ${sectionCard('stock', 'Estoque', 'Colhido − entregue por produto')}
      ${sectionCard('costs', 'Custos por área', 'Talhão')}
      ${sectionCard('revenue', 'Receita × Despesas por área', 'Colheita × preço médio vs custos')}
    </div>`;
  paintCharts(data, productFilterValue).catch(() => {});
}

export function stopAgroDashboard() {
  destroyCharts();
}

export async function renderAgroDashboard(root) {
  const body = root.querySelector('#agro-body');
  if (body) body.innerHTML = `<p class="muted">Carregando indicadores…</p>`;
  const now = new Date();
  const state = root._agroDashState || {
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    product: '',
  };
  root._agroDashState = state;

  const load = async () => {
    const data = await api(`/api/agro/dashboard?month=${state.month}&year=${state.year}`);
    paint(root, data, state.product);
  };

  if (root.dataset.agroDashBound !== '1') {
    root.dataset.agroDashBound = '1';
    root.addEventListener('change', (event) => {
      const current = root._agroDashState;
      if (!current) return;
      const targetBody = root.querySelector('#agro-body');
      if (event.target?.id === 'agro-dash-month') {
        current.month = Number(event.target.value);
        load().catch((error) => {
          if (targetBody) {
            targetBody.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Falha ao carregar')}</p>`;
          }
        });
        return;
      }
      if (event.target?.id === 'agro-dash-year') {
        current.year = Number(event.target.value);
        load().catch((error) => {
          if (targetBody) {
            targetBody.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Falha ao carregar')}</p>`;
          }
        });
        return;
      }
      if (event.target?.id === 'agro-dash-product') {
        current.product = event.target.value;
        load().catch(() => {});
      }
    });
  }

  try {
    await load();
  } catch (error) {
    if (body) body.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Não foi possível carregar o dashboard')}</p>`;
  }
}
