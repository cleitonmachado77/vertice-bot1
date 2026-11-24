import { api } from '../api.js';
import { escapeHtml, statCard } from '../ui.js';

const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

let chartReady = null;
const chartInstances = new Map();
/** Invalida pinturas/carregamentos antigos ao trocar empresa ou período. */
let agroDashEpoch = 0;

const CHART_CDN_CANDIDATES = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.6/+esm',
  'https://unpkg.com/chart.js@4.4.1/auto/+esm',
];

async function loadChartJs() {
  if (chartReady) return chartReady;
  chartReady = (async () => {
    let lastError = null;
    for (const url of CHART_CDN_CANDIDATES) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        const Chart = mod.Chart || mod.default;
        if (!Chart) throw new Error('Chart.js sem export Chart');
        if (mod.BarController && mod.BarElement && mod.CategoryScale && mod.LinearScale) {
          Chart.register(
            mod.BarController,
            mod.BarElement,
            mod.CategoryScale,
            mod.LinearScale,
            mod.Legend,
            mod.Tooltip,
          );
        }
        return { Chart };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Não foi possível carregar Chart.js');
  })().catch((error) => {
    chartReady = null;
    throw error;
  });
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
        <canvas id="agro-chart-${escapeHtml(id)}" height="220" aria-label="${escapeHtml(title)}"></canvas>
        <p class="agro-dash-empty muted" id="agro-chart-empty-${escapeHtml(id)}" hidden>Sem dados neste período</p>
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
    const { ctx, chartArea } = chart;
    const format = chart.options.plugins?.barValueLabels?.format || formatQty;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '600 11px Outfit, "Segoe UI", sans-serif';
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden) return;
      meta.data.forEach((element, index) => {
        const raw = Number(dataset.data[index]);
        if (!Number.isFinite(raw) || raw === 0) return;
        const { x, y, base } = element.getProps(['x', 'y', 'base'], true);
        const text = format(raw);
        const barHeight = Math.abs(base - y);
        const inside = barHeight > 22;
        ctx.textBaseline = inside ? 'top' : 'bottom';
        ctx.fillStyle = inside ? '#ffffff' : '#3a3a3e';
        const ty = inside ? Math.min(y + 6, (chartArea?.bottom || y) - 4) : y - 4;
        ctx.fillText(text, x, ty);
      });
    });
    ctx.restore();
  },
};

function setChartEmpty(canvas, empty) {
  const emptyEl = document.getElementById(`agro-chart-empty-${canvas.id.replace(/^agro-chart-/, '')}`);
  canvas.hidden = Boolean(empty);
  if (emptyEl) emptyEl.hidden = !empty;
}

function makeBar(Chart, canvas, labels, values, label, color = '#2e8b57', format = formatQty) {
  const hasData = values.some((value) => Number(value) > 0);
  setChartEmpty(canvas, !hasData);
  if (!hasData) return;

  const existing = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      /* ignore */
    }
  }

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
          maxBarThickness: 48,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 22, right: 8 } },
      plugins: {
        legend: { display: false },
        barValueLabels: { format },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `${ctx.dataset.label}: ${format(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { autoSkip: false, maxRotation: 0, minRotation: 0 },
        },
        y: {
          beginAtZero: true,
          ticks: {
            precision: 0,
            callback(value) {
              return format(value);
            },
          },
        },
      },
    },
    plugins: [barValueLabels],
  });
  chart.resize();
  chartInstances.set(canvas.id, chart);
}

function makeGrouped(Chart, canvas, rows) {
  const hasData = rows.some((item) => Number(item.revenue) > 0 || Number(item.expense) > 0);
  setChartEmpty(canvas, !hasData);
  if (!hasData) return;

  const existing = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      /* ignore */
    }
  }

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
      animation: false,
      layout: { padding: { top: 22, right: 8 } },
      plugins: {
        legend: { position: 'bottom' },
        barValueLabels: { format: formatMoney },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: {
            callback(value) {
              return formatMoney(value);
            },
          },
        },
      },
    },
    plugins: [barValueLabels],
  });
  chart.resize();
  chartInstances.set(canvas.id, chart);
}

/** Pintura síncrona — sem await entre montar o DOM e criar os charts (evita canvas em branco). */
function paintChartsSync(Chart, data) {
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
    if (!canvas || !canvas.isConnected) continue;
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
  if (revenueCanvas?.isConnected) makeGrouped(Chart, revenueCanvas, data.revenueExpenseByArea || []);
}

async function paint(root, data, productFilterValue = '', epoch = agroDashEpoch) {
  if (epoch !== agroDashEpoch) return;

  // Chart.js ANTES de tocar no DOM: se a epoch mudar no await, não deixamos cards vazios.
  let Chart;
  try {
    ({ Chart } = await loadChartJs());
  } catch (error) {
    if (epoch !== agroDashEpoch) return;
    destroyCharts();
    const actions = root.querySelector('#agro-dash-actions') || root.querySelector('.forms-top-actions');
    if (actions) {
      actions.innerHTML = `${productFilter(data.products, productFilterValue)}${periodPicker(data.period)}`;
    }
    const body = root.querySelector('#agro-body');
    if (!body) return;
    body.innerHTML = `
      <div class="stat-row agro-dash-stats" aria-label="Resumo agro">${summaryCards(data.summary)}</div>
      <p class="muted agro-dash-chart-error">Gráficos indisponíveis: ${escapeHtml(error.message || 'falha ao carregar Chart.js')}</p>`;
    return;
  }
  if (epoch !== agroDashEpoch) return;

  destroyCharts();
  const actions = root.querySelector('#agro-dash-actions') || root.querySelector('.forms-top-actions');
  if (actions) {
    actions.innerHTML = `${productFilter(data.products, productFilterValue)}${periodPicker(data.period)}`;
  }
  const body = root.querySelector('#agro-body');
  if (!body) return;
  body.innerHTML = `
    <div class="stat-row agro-dash-stats" aria-label="Resumo agro">${summaryCards(data.summary)}</div>
    <div class="agro-dash-grid">
      ${sectionCard('forecast', 'Estimativa de produção', 'Quantidades na data estimada')}
      ${sectionCard('planting', 'Plantio', 'Quantidade prevista por produto no período')}
      ${sectionCard('harvest', 'Colheita', 'Unidade por produto')}
      ${sectionCard('delivery', 'Entrega', 'Unidade por produto')}
      ${sectionCard('sales', 'Venda', 'R$ por produto')}
      ${sectionCard('stock', 'Estoque', 'Colhido − entregue por produto')}
      ${sectionCard('costs', 'Custos por área', 'Talhão')}
      ${sectionCard('revenue', 'Receita × Despesas por área', 'Colheita × preço médio vs custos')}
    </div>
    <p class="muted agro-dash-chart-error" id="agro-dash-chart-error" hidden></p>`;
  if (epoch !== agroDashEpoch) return;
  paintChartsSync(Chart, data);
}

export function stopAgroDashboard() {
  agroDashEpoch += 1;
  destroyCharts();
}

export async function renderAgroDashboard(root) {
  const epoch = (agroDashEpoch += 1);
  destroyCharts();
  // Pré-aquece Chart.js em paralelo com o fetch (não bloqueia o DOM).
  const chartWarm = loadChartJs().catch(() => null);
  const body = root.querySelector('#agro-body');
  if (body) body.innerHTML = `<p class="muted">Carregando indicadores…</p>`;
  const now = new Date();
  const state = root._agroDashState || {
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    product: '',
    companyId: '',
  };
  root._agroDashState = state;

  const load = async ({ resetProduct = false } = {}) => {
    const loadEpoch = (agroDashEpoch += 1);
    if (resetProduct) state.product = '';
    const targetBody = root.querySelector('#agro-body');
    if (targetBody) targetBody.innerHTML = `<p class="muted">Carregando indicadores…</p>`;
    const qs = new URLSearchParams({
      month: String(state.month),
      year: String(state.year),
    });
    if (state.product) qs.set('productId', state.product);
    const [data] = await Promise.all([api(`/api/agro/dashboard?${qs}`), chartWarm]);
    if (loadEpoch !== agroDashEpoch) return;
    state.companyId = String(data.companyId || state.companyId || '');
    await paint(root, data, state.product, loadEpoch);
  };
  root._agroDashLoad = load;

  if (root.dataset.agroDashBound !== '1') {
    root.dataset.agroDashBound = '1';
    root.addEventListener('change', (event) => {
      const current = root._agroDashState;
      if (!current) return;
      const targetBody = root.querySelector('#agro-body');
      if (event.target?.id === 'agro-dash-month') {
        current.month = Number(event.target.value);
        load().catch((error) => {
          if (targetBody && agroDashEpoch) {
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
    if (epoch !== agroDashEpoch) return;
    await load({ resetProduct: true });
  } catch (error) {
    if (epoch !== agroDashEpoch && agroDashEpoch > epoch) return;
    const currentBody = root.querySelector('#agro-body');
    if (currentBody) {
      currentBody.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Não foi possível carregar o dashboard')}</p>`;
    }
  }
}
