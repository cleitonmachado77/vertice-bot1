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
  // Inclui anos futuros para previsão/estimativa de safra (ex.: plantio em 2026 → colheita 2027).
  for (let y = now + 2; y >= now - 6; y -= 1) years.push(y);
  if (selected && !years.includes(selected)) years.push(selected);
  years.sort((a, b) => b - a);
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
    <label class="agro-dash-product">Cultura
      <select id="agro-dash-product" aria-label="Filtrar indicadores por cultura">
        <option value="">Todas</option>
        ${(products || [])
          .map(
            (item) =>
              `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`,
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

function formatHa(value) {
  return `${formatQty(value)} ha`;
}

function summaryCards(summary) {
  return [
    statCard({
      label: 'Área plantada atual',
      value: formatHa(summary?.plantedAreaHa),
      tone: 'green',
      icon: 'sprout',
      title: 'Soma da área (ha) dos plantios ativos',
    }),
    statCard({
      label: 'Produção estimada',
      value: formatQty(summary?.estimatedQty),
      tone: 'teal',
      icon: 'chart',
      title: 'Soma da produção estimada dos plantios ativos',
    }),
    statCard({
      label: 'Coheita realizada',
      value: formatQty(summary?.harvestedQty),
      tone: 'amber',
      icon: 'harvest',
      title: 'Soma das colheitas no período',
    }),
    statCard({
      label: 'Produção entregue',
      value: formatQty(summary?.deliveredQty),
      tone: 'orange',
      icon: 'truck',
      title: 'Soma da produção entregue no período',
    }),
    statCard({
      label: 'Valor vendido',
      value: formatMoney(summary?.soldValue),
      tone: 'blue',
      icon: 'sales',
      title: 'Faturamento das entregas no período',
    }),
    statCard({
      label: 'Custos de produção',
      value: formatMoney(summary?.costs),
      tone: 'navy',
      icon: 'money',
      title: 'Soma dos custos de produção no período',
    }),
  ].join('');
}

/** Plugin local: total sempre visível na barra (não só no hover). */
const barValueLabels = {
  id: 'barValueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const format = chart.options.plugins?.barValueLabels?.format || formatQty;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#3a3a3e';
    ctx.font = '600 11px Outfit, "Segoe UI", sans-serif';
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden) return;
      meta.data.forEach((element, index) => {
        const raw = Number(dataset.data[index]);
        if (!Number.isFinite(raw) || raw === 0) return;
        const { x, y } = element.getProps(['x', 'y'], true);
        ctx.fillText(format(raw), x, y - 4);
      });
    });
    ctx.restore();
  },
};

function makeBar(Chart, canvas, labels, values, label, color = '#2e8b57', format = formatQty) {
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
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { display: false },
        barValueLabels: { format },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
    plugins: [barValueLabels],
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
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { position: 'bottom' },
        barValueLabels: { format: formatMoney },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true },
      },
    },
    plugins: [barValueLabels],
  });
  chartInstances.set(canvas.id, chart);
}

async function paintCharts(data) {
  const { Chart } = await loadChartJs();
  Chart.defaults.color = '#6b6b70';
  Chart.defaults.borderColor = 'rgba(26, 26, 28, 0.06)';
  Chart.defaults.font.family = 'Outfit, "Segoe UI", sans-serif';
  destroyCharts();

  const pairs = [
    ['forecast', data.forecast?.byProduct || [], 'Estimativa', '#2e8b57', formatQty],
    ['planting', data.plantingByProduct || [], 'Mudas', '#3d8b6e', formatQty],
    ['harvest', data.harvestByProduct || [], 'Colheita', '#d4a017', formatQty],
    ['delivery', data.deliveryByProduct || [], 'Entrega', '#c45c26', formatQty],
    ['sales', data.salesByProduct || [], 'Venda (R$)', '#2b5aa8', formatMoney],
    ['stock', data.stockByProduct || [], 'Estoque', '#1f7a5c', formatQty],
    ['costs', data.costsByArea || [], 'Custos por área', '#8b4513', formatMoney],
  ];
  for (const [id, rows, label, color, format] of pairs) {
    const canvas = document.getElementById(`agro-chart-${id}`);
    if (!canvas) continue;
    makeBar(
      Chart,
      canvas,
      rows.map((item) => item.label),
      rows.map((item) => item.value),
      label,
      color,
      format,
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
    <div class="stat-row stat-row--6 agro-dash-stats">${summaryCards(data.summary)}</div>
    <div class="agro-dash-grid">
      ${sectionCard('forecast', 'Estimativa de produção', 'Quantidades na data estimada')}
      ${sectionCard('planting', 'Plantio', 'Quantidade de mudas por produto')}
      ${sectionCard('harvest', 'Colheita', 'Unidade por produto')}
      ${sectionCard('delivery', 'Entrega', 'Unidade por produto')}
      ${sectionCard('sales', 'Venda', 'R$ por produto')}
      ${sectionCard('stock', 'Estoque', 'Colhido − entregue por produto')}
      ${sectionCard('costs', 'Custos por área', 'Talhão')}
      ${sectionCard('revenue', 'Receita × Despesas por área', 'Colheita × preço médio vs custos')}
    </div>`;
  paintCharts(data).catch(() => {});
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
    const qs = new URLSearchParams({
      month: String(state.month),
      year: String(state.year),
    });
    if (state.product) qs.set('productId', state.product);
    const data = await api(`/api/agro/dashboard?${qs}`);
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
