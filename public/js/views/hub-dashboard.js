import { api } from '../api.js';
import { escapeHtml } from '../ui.js';

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
  '#3d9a78',
  '#5b8def',
  '#e0a84c',
  '#d9776b',
  '#8b7ec8',
  '#4db6ac',
  '#90a4ae',
  '#c7906a',
  '#6d9eeb',
  '#a3b18a',
  '#e07a5f',
  '#81b29a',
];

let chartReady = null;
const chartInstances = new Map();

async function loadChartJs() {
  if (chartReady) return chartReady;
  chartReady = (async () => {
    const mod = await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm');
    const {
      Chart,
      BarController,
      BarElement,
      CategoryScale,
      LinearScale,
      DoughnutController,
      ArcElement,
      Legend,
      Tooltip,
      Filler,
    } = mod;
    Chart.register(
      BarController,
      BarElement,
      CategoryScale,
      LinearScale,
      DoughnutController,
      ArcElement,
      Legend,
      Tooltip,
      Filler,
    );
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

export function renderDashboardShell(period) {
  const month = period?.month || new Date().getMonth() + 1;
  const year = period?.year || new Date().getFullYear();
  return `
    <section class="card hub-dashboard" id="hub-dashboard" aria-label="Dashboard">
      <div class="hub-dashboard-head">
        <div>
          <h2>Dashboard</h2>
        </div>
        <div class="hub-dashboard-filters">
          <label>
            <span>Mês</span>
            <select id="hub-dash-month">${monthOptions(month)}</select>
          </label>
          <label>
            <span>Ano</span>
            <select id="hub-dash-year">${yearOptions(year)}</select>
          </label>
        </div>
      </div>
      <div class="hub-dashboard-body" id="hub-dashboard-body">
        <p class="muted hub-dashboard-loading">Carregando indicadores…</p>
      </div>
    </section>`;
}

function sectionHtml(id, title, totalLabel, totalValue, barTitle, pieTitle, barMeta = '') {
  return `
    <article class="hub-dash-section" data-section="${escapeHtml(id)}">
      <div class="hub-dash-section-head">
        <h3>${escapeHtml(title)}</h3>
        <p class="hub-dash-total">${escapeHtml(totalLabel)} <strong>${escapeHtml(totalValue)}</strong></p>
      </div>
      <div class="hub-dash-charts">
        <div class="hub-dash-chart-card">
          <div class="hub-dash-chart-card-head">
            <p class="hub-dash-chart-title">${escapeHtml(barTitle)}</p>
            ${
              barMeta
                ? `<p class="hub-dash-chart-meta">${barMeta}</p>`
                : ''
            }
          </div>
          <div class="hub-dash-canvas-wrap">
            <canvas id="chart-${escapeHtml(id)}-bar"></canvas>
          </div>
        </div>
        <div class="hub-dash-chart-card">
          <p class="hub-dash-chart-title">${escapeHtml(pieTitle)}</p>
          <div class="hub-dash-canvas-wrap hub-dash-canvas-wrap--pie">
            <canvas id="chart-${escapeHtml(id)}-pie"></canvas>
          </div>
        </div>
      </div>
    </article>`;
}

function receiptsBarMeta(section) {
  const unit = String(section?.unit || '').trim();
  const totalText = section?.totalLabel || `${formatQty(section?.total)}${unit ? ` ${unit}` : ''}`;
  const unitText = unit ? escapeHtml(unit) : '—';
  return `Unidade: <strong>${unitText}</strong> · Total: <strong>${escapeHtml(totalText)}</strong>`;
}

function paintBody(data) {
  const body = document.querySelector('#hub-dashboard-body');
  if (!body) return;

  const receiptsTotal = data.receipts?.totalLabel || formatQty(data.receipts?.total);

  body.innerHTML = `
    ${sectionHtml(
      'receipts',
      'Recebimentos',
      'Total recebido',
      receiptsTotal,
      'Recebimentos por dia',
      'Total por catador',
      receiptsBarMeta(data.receipts),
    )}
    ${sectionHtml(
      'production',
      'Produção',
      'Total produzido',
      formatQty(data.production?.total),
      'Produção por dia / produto',
      'Total por produto',
    )}
    ${sectionHtml(
      'sales',
      'Vendas',
      'Total vendido',
      formatMoney(data.sales?.total),
      'Vendas por dia / produto',
      'Total vendido (R$) por produto',
    )}`;
}

function chartDefaults(Chart) {
  Chart.defaults.color = 'rgba(255,255,255,0.62)';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';
  Chart.defaults.font.family = 'Poppins, sans-serif';
}

function makeBar(Chart, canvas, labels, datasets, isMoney) {
  if (!canvas) return;
  const existing = chartInstances.get(canvas.id);
  if (existing) existing.destroy();
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label(ctx) {
              const value = ctx.parsed.y ?? ctx.parsed;
              const prefix = ctx.dataset.label ? `${ctx.dataset.label}: ` : '';
              return prefix + (isMoney ? formatMoney(value) : formatQty(value));
            },
          },
        },
      },
      scales: {
        x: { stacked: datasets.length > 1, grid: { display: false } },
        y: {
          stacked: datasets.length > 1,
          beginAtZero: true,
          ticks: {
            callback(value) {
              return isMoney ? formatMoney(value) : formatQty(value);
            },
          },
        },
      },
    },
  });
  chartInstances.set(canvas.id, chart);
}

function makePie(Chart, canvas, labels, values, isMoney) {
  if (!canvas) return;
  const existing = chartInstances.get(canvas.id);
  if (existing) existing.destroy();
  const hasData = values.some((v) => v > 0);
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: hasData ? labels : ['Sem dados'],
      datasets: [
        {
          data: hasData ? values : [1],
          backgroundColor: hasData ? labels.map((_, i) => PALETTE[i % PALETTE.length]) : ['rgba(255,255,255,0.12)'],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label(ctx) {
              if (!hasData) return 'Sem dados no período';
              const value = ctx.parsed;
              return `${ctx.label}: ${isMoney ? formatMoney(value) : formatQty(value)}`;
            },
          },
        },
      },
    },
  });
  chartInstances.set(canvas.id, chart);
}

function stackedDatasets(section) {
  const products = section.products?.length
    ? section.products
    : [...new Set((section.dailyStacked || []).flatMap((d) => Object.keys(d.byProduct || {})))];
  if (!products.length) {
    return [
      {
        label: 'Total',
        data: (section.daily || []).map((d) => d.value),
        backgroundColor: PALETTE[0],
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

async function paintCharts(data) {
  const { Chart } = await loadChartJs();
  chartDefaults(Chart);
  destroyCharts();

  makeBar(
    Chart,
    document.querySelector('#chart-receipts-bar'),
    (data.receipts?.daily || []).map((d) => d.label),
    [
      {
        label: 'Recebido',
        data: (data.receipts?.daily || []).map((d) => d.value),
        backgroundColor: PALETTE[0],
        borderRadius: 4,
      },
    ],
    false,
  );
  makePie(
    Chart,
    document.querySelector('#chart-receipts-pie'),
    (data.receipts?.breakdown || []).map((d) => d.label),
    (data.receipts?.breakdown || []).map((d) => d.value),
    false,
  );

  makeBar(
    Chart,
    document.querySelector('#chart-production-bar'),
    (data.production?.daily || []).map((d) => d.label),
    stackedDatasets(data.production || {}),
    false,
  );
  makePie(
    Chart,
    document.querySelector('#chart-production-pie'),
    (data.production?.breakdown || []).map((d) => d.label),
    (data.production?.breakdown || []).map((d) => d.value),
    false,
  );

  makeBar(
    Chart,
    document.querySelector('#chart-sales-bar'),
    (data.sales?.daily || []).map((d) => d.label),
    stackedDatasets(data.sales || {}),
    true,
  );
  makePie(
    Chart,
    document.querySelector('#chart-sales-pie'),
    (data.sales?.breakdown || []).map((d) => d.label),
    (data.sales?.breakdown || []).map((d) => d.value),
    true,
  );
}

let companyChangeHandler = null;

export async function mountHubDashboard(root) {
  const monthEl = root.querySelector('#hub-dash-month');
  const yearEl = root.querySelector('#hub-dash-year');
  if (!monthEl || !yearEl) return;

  const load = async () => {
    const month = Number(monthEl.value);
    const year = Number(yearEl.value);
    const body = root.querySelector('#hub-dashboard-body');
    if (body) body.innerHTML = '<p class="muted hub-dashboard-loading">Carregando indicadores…</p>';
    destroyCharts();
    try {
      const data = await api(`/api/hub/dashboard?month=${month}&year=${year}`);
      paintBody(data);
      try {
        await paintCharts(data);
      } catch (chartError) {
        console.error('dashboard charts:', chartError);
        const tip = document.createElement('p');
        tip.className = 'muted';
        tip.textContent = `Gráficos indisponíveis: ${chartError.message || 'erro ao carregar Chart.js'}`;
        body?.appendChild(tip);
      }
    } catch (error) {
      if (body) {
        body.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Falha ao carregar dashboard')}</p>`;
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
