import { api } from '../api.js';
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
    chartTitle: 'Bags produzidas por dia, por produto',
    totalLabel: 'Total separado',
    statLabel: 'Bags separadas',
    tone: 'teal',
    color: '#1aa897',
    icon: 'box',
    href: '#/forms/fabricacao',
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

function sectionHtml(def, section) {
  return `
    <article class="card hub-dash-section tone-${def.tone}" data-section="${escapeHtml(def.id)}">
      <div class="hub-dash-section-head">
        <h3>${escapeHtml(def.title)}</h3>
        <p class="hub-dash-total">${escapeHtml(def.totalLabel)} <strong>${escapeHtml(formatValue(section?.unit, section?.total))}</strong></p>
      </div>
      <p class="hub-dash-chart-title">${escapeHtml(def.chartTitle)}</p>
      <div class="hub-dash-canvas-wrap">
        <canvas id="chart-${escapeHtml(def.id)}"></canvas>
      </div>
    </article>`;
}

function paintBody(data) {
  const stats = document.querySelector('#hub-stats');
  if (stats) stats.innerHTML = statsCards(data);
  const body = document.querySelector('#hub-dashboard-body');
  if (!body) return;
  body.innerHTML = SECTIONS.map((def) => sectionHtml(def, data[def.id])).join('');
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

function makeBar(Chart, canvas, def, section) {
  if (!canvas) return;
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

async function paintCharts(data) {
  const { Chart } = await loadChartJs();
  chartDefaults(Chart);
  destroyCharts();
  for (const def of SECTIONS) {
    makeBar(Chart, document.querySelector(`#chart-${def.id}`), def, data[def.id] || {});
  }
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
    if (body) body.innerHTML = '<p class="card muted hub-dashboard-loading">Carregando indicadores…</p>';
    const stats = root.querySelector('#hub-stats');
    if (stats) stats.innerHTML = statsCards();
    destroyCharts();
    try {
      const data = await api(`/api/hub/dashboard?month=${month}&year=${year}`);
      paintBody(data);
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
